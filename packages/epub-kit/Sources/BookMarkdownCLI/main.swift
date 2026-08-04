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

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("book-md: " + message + "\n\n" + """
    Usage: book-md <file.md> [--roundtrip]

      <file.md>      a book in the format docs/data-not-format.md specifies
      --roundtrip    assert the serializer is a fixpoint and print nothing else.
                     Exits non-zero with a unified diff when it is not.

    """).utf8))
    exit(1)
}

var args = Array(CommandLine.arguments.dropFirst())
var roundtrip = false
var path: String?
while let arg = args.first {
    args.removeFirst()
    switch arg {
    case "--roundtrip": roundtrip = true
    default:
        if path != nil { die("more than one file given") }
        path = arg
    }
}
guard let path else { die("no file given") }
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
    "images": images(doc.preamble),
]

let data = try! JSONSerialization.data(withJSONObject: payload,
                                       options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data("\n".utf8))
