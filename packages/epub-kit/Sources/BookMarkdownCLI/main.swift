import Foundation
import EpubKit

// book-md — the Swift side of the cross-parser check.
//
// It prints what docs/data-not-format.md calls DATA, and nothing it calls
// format. That distinction is the whole contract: a diff on this output is a
// diff on what the book means, so it can be red and mean something. A diff on
// bytes would be red forever and mean nothing.
//
//   book-md <file.md>              the data columns, as JSON
//   book-md <file.md> --roundtrip  serialize(parse(serialize(x))) == serialize(x)
//   book-md <dir> --epub <out>     build an EPUB 3 straight from markdown
//
// The --epub path is why the format was written down. It reaches the same
// assembler the OCR path reaches — one package document, one navigation
// document, one set of chapter XHTML — so a book that arrives as markdown and a
// book that arrives as a scan become the same book, not two books that resemble
// each other.

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("book-md: " + message + "\n\n" + """
    Usage: book-md <file.md> [--roundtrip]
           book-md <dir> --epub <out.epub> [--title <text>] [--author <name>]
                         [--images <dir>] [--cover <file.jpeg>]

      <file.md>      a book in the format docs/data-not-format.md specifies
      --roundtrip    assert the serializer is a fixpoint and print nothing else.
                     Exits non-zero with a unified diff when it is not.
      --epub <out>   build an EPUB 3 from every .md in <dir>, in filename order.
                     Chapters keep their own headings; the book's title comes
                     from --title, or from the first document's frontmatter.
      --images <dir> where the image hrefs resolve. Anything not found is named
                     in the report rather than failing the build or vanishing.
      --cover <file> cover image. Without one the book has no cover, which is a
                     smaller book, not a broken one.
      --lang <tag>   BCP-47. No default: a guess mislabels the book. Taken from
                     the first document's frontmatter when not given.

    """).utf8))
    exit(1)
}

var args = Array(CommandLine.arguments.dropFirst())
var roundtrip = false
var path: String?
var epubOut: String?
var titleArg: String?
var authorArg = ""
var imagesArg: String?
var coverArg: String?
var langArg: String?
while let arg = args.first {
    args.removeFirst()
    func value(_ flag: String) -> String {
        guard let v = args.first else { die("\(flag) needs a value") }
        args.removeFirst()
        return v
    }
    switch arg {
    case "--roundtrip": roundtrip = true
    case "--epub": epubOut = value("--epub")
    case "--title": titleArg = value("--title")
    case "--author": authorArg = value("--author")
    case "--images": imagesArg = value("--images")
    case "--cover": coverArg = value("--cover")
    case "--lang": langArg = value("--lang")
    default:
        if path != nil { die("more than one file given") }
        path = arg
    }
}
guard let path else { die("no file given") }

// ── build a book ─────────────────────────────────────────────────────────────

if let epubOut {
    let fm = FileManager.default
    var isDirectory: ObjCBool = false
    guard fm.fileExists(atPath: path, isDirectory: &isDirectory) else { die("cannot read \(path)") }

    // Filename order, not directory order: readdir gives whatever the
    // filesystem feels like, and a book that ships out of order is the defect
    // sortChapterFiles exists for on the Node side.
    let files: [String]
    if isDirectory.boolValue {
        files = ((try? fm.contentsOfDirectory(atPath: path)) ?? [])
            .filter { $0.hasSuffix(".md") && $0 != "README.md" }
            .sorted()
            .map { (path as NSString).appendingPathComponent($0) }
    } else {
        files = [path]
    }
    if files.isEmpty { die("no .md files in \(path)") }

    var chapters: [BookChapter] = []
    var first: BookMetadata?
    // Files that produced no chapter at all. Usually correct — an empty file is
    // an empty file — but it is a file the caller listed and the book does not
    // contain, so it gets named. Silence here is how 110 chapters became 109
    // without anybody noticing.
    var contributedNothing: [String] = []
    for file in files {
        guard let text = try? String(contentsOfFile: file, encoding: .utf8) else {
            die("cannot read \(file)")
        }
        let parsed = BookMarkdown.parse(text)
        if first == nil { first = parsed.metadata }
        // A document with content before its first heading still has that
        // content. It becomes a chapter named after the file rather than being
        // dropped — silently losing it is the failure this whole path is a
        // reaction to.
        if !parsed.preamble.isEmpty {
            chapters.append(BookChapter(level: 1,
                                        title: ((file as NSString).lastPathComponent as NSString)
                                            .deletingPathExtension,
                                        blocks: parsed.preamble))
        }
        if parsed.chapters.isEmpty && parsed.preamble.isEmpty {
            contributedNothing.append((file as NSString).lastPathComponent)
        }
        chapters.append(contentsOf: parsed.chapters)
    }

    let title = titleArg ?? first?.title ?? ""
    if title.isEmpty { die("no title: pass --title, or give the first document one in its frontmatter") }

    // No default. A guessed language mislabels the book, and dc:language is
    // data — the ledger's first table says so, and a Kindle reads it.
    let language = langArg ?? first?.lang ?? ""
    if language.isEmpty {
        die("no language: pass --lang, or give the first document a `lang:` in its frontmatter")
    }

    let document = BookDocument(metadata: first ?? BookMetadata(), preamble: [], chapters: chapters)
    do {
        let report = try EpubBuilder.build(
            document: document,
            metadata: EpubMetadata(title: title, author: authorArg, language: language),
            outputURL: URL(fileURLWithPath: epubOut),
            imagesDirectory: imagesArg.map { URL(fileURLWithPath: $0) },
            coverImageURL: coverArg.map { URL(fileURLWithPath: $0) })
        print("book-md: \(files.count) files → \(chapters.count) chapters → \(epubOut)")
        // The report is printed even when it is empty, so "nothing was lost" is
        // something the run says rather than something the reader assumes.
        print("  files that produced no chapter: \(contributedNothing.count)"
            + (contributedNothing.isEmpty ? "" : " — \(contributedNothing.joined(separator: ", "))"))
        print("  images not found: \(report.imagesNotFound.count)")
        for href in report.imagesNotFound.prefix(20) { print("    \(href)") }
        if report.pictographsRemoved > 0 {
            print("  pictographs removed: \(report.pictographsRemoved) "
                + "(they cost a book its cover and table of contents on a Kindle)")
        }
        exit(0)
    } catch {
        FileHandle.standardError.write(Data("book-md: \(error)\n".utf8))
        exit(1)
    }
}

guard let source = try? String(contentsOfFile: path, encoding: .utf8) else {
    die("cannot read \(path)")
}

let doc = BookMarkdown.parse(source)

if roundtrip {
    // The first serialize normalizes the format; from there it must not move.
    let once = BookMarkdown.serialize(doc)
    let twice = BookMarkdown.serialize(BookMarkdown.parse(once))
    if once == twice { exit(0) }

    let a = once.components(separatedBy: "\n")
    let b = twice.components(separatedBy: "\n")
    var report = "not a fixpoint: serialize(parse(serialize(x))) != serialize(x)\n"
    for i in 0..<max(a.count, b.count) where (i < a.count ? a[i] : nil) != (i < b.count ? b[i] : nil) {
        report += "  line \(i + 1)\n"
        report += "    once:  \(i < a.count ? a[i] : "<end>")\n"
        report += "    twice: \(i < b.count ? b[i] : "<end>")\n"
    }
    FileHandle.standardError.write(Data(report.utf8))
    exit(1)
}

// MARK: - the data columns

/// Text is compared normalized, because whitespace and line wrapping in the
/// source are format. Two parsers that disagree about how a paragraph was
/// wrapped have not disagreed about the book.
func normalized(_ s: String) -> String {
    s.components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
}

func texts(_ blocks: [BookBlock]) -> [String] {
    var out: [String] = []
    for block in blocks {
        switch block {
        case let .paragraph(t): out.append(normalized(t))
        case let .heading(_, t): out.append(normalized(t))
        case let .list(_, items): out.append(contentsOf: items.map(normalized))
        case let .quote(inner): out.append(contentsOf: texts(inner))
        case .image, .fence: continue   // fences are not prose; images below
        }
    }
    return out
}

func images(_ blocks: [BookBlock]) -> [[String: Any]] {
    var out: [[String: Any]] = []
    for block in blocks {
        switch block {
        case let .image(href, alt, _):
            // The embed form is deliberately absent: it is format, preserved by
            // the serializer but never something the two sides must agree on.
            out.append(["href": href, "alt": alt as Any? ?? NSNull()])
        case let .quote(inner): out.append(contentsOf: images(inner))
        default: continue
        }
    }
    return out
}

/// Inline links, in order. Data: it is how a reader reaches what is cited, and
/// a book that prints `[label](url)` as characters has lost it.
func links(_ blocks: [BookBlock]) -> [[String]] {
    var out: [[String]] = []
    for block in blocks {
        switch block {
        case let .paragraph(t), let .heading(_, t):
            out.append(contentsOf: BookMarkdown.links(in: t).map { [$0.text, $0.href] })
        case let .list(_, items):
            for item in items {
                out.append(contentsOf: BookMarkdown.links(in: item).map { [$0.text, $0.href] })
            }
        case let .quote(inner): out.append(contentsOf: links(inner))
        case .image, .fence: continue
        }
    }
    return out
}

func headingLevels(_ blocks: [BookBlock]) -> [Int] {
    var out: [Int] = []
    for block in blocks {
        switch block {
        case let .heading(level, _): out.append(level)
        case let .quote(inner): out.append(contentsOf: headingLevels(inner))
        default: continue
        }
    }
    return out
}

var payload: [String: Any] = [
    "title": doc.metadata.title,
    "lang": doc.metadata.lang,
    "direction": doc.metadata.direction,
    "author": doc.metadata.author as Any? ?? NSNull(),
    "translator": doc.metadata.translator as Any? ?? NSNull(),
    "cover": doc.metadata.cover as Any? ?? NSNull(),
]
payload["chapters"] = doc.chapters.map { chapter -> [String: Any] in
    [
        "level": chapter.level,
        "title": normalized(chapter.title),
        "text": texts(chapter.blocks),
        "images": images(chapter.blocks),
        // Heading levels found under a chapter — including the ones nested in a
        // blockquote, which is the hazard that shipped as a literal '#'.
        "innerHeadingLevels": headingLevels(chapter.blocks),
        "links": links(chapter.blocks),
    ]
}
// Content before the first chapter heading. Reported with its heading levels,
// not flattened to text: a book can open with a quoted aphorism carrying a
// heading (`> # …`), and flattening it here would hide the exact hazard the
// corpus was extended to cover — the check would go green on a parser that had
// thrown the structure away.
payload["preamble"] = [
    "text": texts(doc.preamble),
    "headingLevels": headingLevels(doc.preamble),
    "links": links(doc.preamble),
    "images": images(doc.preamble),
]

let data = try! JSONSerialization.data(withJSONObject: payload,
                                       options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
