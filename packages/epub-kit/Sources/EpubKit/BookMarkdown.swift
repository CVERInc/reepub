// The book format, read and written in Swift.
//
// docs/data-not-format.md is the specification this implements, and it is worth
// saying which direction that dependency runs: the spec was written first, the
// fixture corpus was chosen before this file existed, and this parser is checked
// against both. That is the whole reason the format travels as markdown rather
// than as a shared library — two implementations of one WRITTEN format is not
// the trap of two undocumented implementations agreeing in a comment
// (PRINCIPLES §6). Take away the spec and the corpus and it becomes that trap.
//
// What this preserves and what it drops is not a judgement call made here. The
// ledger's table decides it, per page kind, and the round-trip check compares
// the data columns rather than bytes:
//
//     serialize(parse(serialize(x))) == serialize(x)     // idempotent, not identical
//
// The first serialize normalizes; from there it must be a fixpoint. Byte
// identity is the wrong test — it would force the format to be preserved, which
// is the exact failure the ledger exists to prevent.
import Foundation

// MARK: - The model

/// Frontmatter. Unknown keys are carried through in source order: this format
/// is one dialect of a family, and a parser that silently dropped a key it did
/// not recognise would edit a person's document without being asked.
public struct BookMetadata: Equatable {
    public var title: String = ""
    public var lang: String = ""
    /// "ltr" or "rtl". Looks like typography and is data: an EPUB missing it has
    /// its cover and table of contents hidden for the whole book by Amazon's
    /// converter, while passing epubcheck at zero errors.
    public var direction: String = ""
    public var author: String?
    public var translator: String?
    public var cover: String?
    /// Keys this parser has no opinion about, in the order they were read.
    public var extras: [(key: String, value: String)] = []

    public static func == (a: BookMetadata, b: BookMetadata) -> Bool {
        a.title == b.title && a.lang == b.lang && a.direction == b.direction
            && a.author == b.author && a.translator == b.translator && a.cover == b.cover
            && a.extras.map({ [$0.key, $0.value] }) == b.extras.map({ [$0.key, $0.value] })
    }
}

/// How an image was written. Both forms carry identical data; the form itself is
/// format. It is preserved anyway — rewriting a person's file into an equivalent
/// is still editing it — but nothing downstream may depend on which one it was.
public enum EmbedForm: String, Equatable {
    case wiki      // ![[cover.png|alt]]
    case inline    // ![alt](cover.png)
}

public indirect enum BookBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    /// Quoted content. A heading inside a blockquote is still a heading — found
    /// the hard way: strip the `> ` and wrap the rest in a paragraph and a
    /// literal `#` prints into the finished book.
    case quote([BookBlock])
    case list(marker: Character, items: [String])
    case image(href: String, alt: String?, form: EmbedForm)
    /// Fenced block. Headings inside are not structure.
    case fence(fenceChar: Character, info: String, lines: [String])
}

/// A chapter is a heading and everything under it. A chapter with a title and no
/// body is still a chapter: it holds a place in the spine and a line in the
/// table of contents, and dropping it changes the order a reader meets things.
public struct BookChapter: Equatable {
    public var level: Int
    public var title: String
    public var blocks: [BookBlock]
    public init(level: Int, title: String, blocks: [BookBlock] = []) {
        self.level = level
        self.title = title
        self.blocks = blocks
    }
}

public struct BookDocument: Equatable {
    public var metadata: BookMetadata
    /// Content before the first heading. Rare, and not silently discarded.
    public var preamble: [BookBlock]
    public var chapters: [BookChapter]
}

// MARK: - Parsing

public enum BookMarkdown {

    public static func parse(_ source: String) -> BookDocument {
        var lines = source.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n")
        let metadata = takeFrontmatter(&lines)
        let blocks = parseBlocks(lines)

        var preamble: [BookBlock] = []
        var chapters: [BookChapter] = []
        for block in blocks {
            if case let .heading(level, text) = block {
                chapters.append(BookChapter(level: level, title: text))
            } else if chapters.isEmpty {
                preamble.append(block)
            } else {
                chapters[chapters.count - 1].blocks.append(block)
            }
        }
        return BookDocument(metadata: metadata, preamble: preamble, chapters: chapters)
    }

    // MARK: frontmatter

    private static func takeFrontmatter(_ lines: inout [String]) -> BookMetadata {
        var meta = BookMetadata()
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---" else { return meta }
        guard let close = lines.dropFirst().firstIndex(where: {
            $0.trimmingCharacters(in: .whitespaces) == "---"
        }) else { return meta }

        for raw in lines[1..<close] {
            guard let colon = raw.firstIndex(of: ":") else { continue }
            let key = String(raw[raw.startIndex..<colon]).trimmingCharacters(in: .whitespaces)
            let value = String(raw[raw.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            switch key {
            case "title": meta.title = value
            case "lang": meta.lang = value
            case "direction": meta.direction = value
            case "author": meta.author = value
            case "translator": meta.translator = value
            case "cover": meta.cover = value
            default: meta.extras.append((key: key, value: value))
            }
        }
        lines.removeSubrange(0...close)
        return meta
    }

    // MARK: blocks

    private static func parseBlocks(_ lines: [String]) -> [BookBlock] {
        var out: [BookBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty { i += 1; continue }

            // A fence swallows everything to its closing marker, headings included.
            if let fence = fenceOpener(trimmed) {
                var body: [String] = []
                i += 1
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if let closer = fenceOpener(t), closer.char == fence.char,
                       closer.count >= fence.count, closer.info.isEmpty { i += 1; break }
                    body.append(lines[i])
                    i += 1
                }
                out.append(.fence(fenceChar: fence.char, info: fence.info, lines: body))
                continue
            }

            // Blockquote: gather the run, strip one level, parse what is left with
            // the same rules. That recursion is the fix for `> # heading`.
            if trimmed.hasPrefix(">") {
                var inner: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    if t.hasPrefix(">") {
                        var rest = String(t.dropFirst())
                        if rest.hasPrefix(" ") { rest.removeFirst() }
                        inner.append(rest)
                        i += 1
                    } else if t.isEmpty, i + 1 < lines.count,
                              lines[i + 1].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
                        inner.append("")
                        i += 1
                    } else {
                        break
                    }
                }
                out.append(.quote(parseBlocks(inner)))
                continue
            }

            if let h = heading(trimmed) {
                out.append(.heading(level: h.level, text: h.text))
                i += 1
                continue
            }

            if let img = embed(trimmed) {
                out.append(.image(href: img.href, alt: img.alt, form: img.form))
                i += 1
                continue
            }

            if let first = listItem(trimmed) {
                var items = [first.text]
                let marker = first.marker
                i += 1
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard let next = listItem(t), next.marker == marker else { break }
                    items.append(next.text)
                    i += 1
                }
                out.append(.list(marker: marker, items: items))
                continue
            }

            // A paragraph ends at a blank line, not at a line ending — the ledger
            // puts paragraph boundaries in the data column and source line
            // wrapping in the format column. Treating every line as its own
            // paragraph round-trips perfectly and is still wrong, which is why
            // the fixpoint check cannot be the only check.
            var run = [trimmed]
            i += 1
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespaces)
                if t.isEmpty || t.hasPrefix(">") || heading(t) != nil
                    || fenceOpener(t) != nil || listItem(t) != nil || embed(t) != nil { break }
                run.append(t)
                i += 1
            }
            out.append(.paragraph(run.joined(separator: " ")))
        }
        return out
    }

    // MARK: line shapes

    private static func fenceOpener(_ t: String) -> (char: Character, count: Int, info: String)? {
        guard let first = t.first, first == "`" || first == "~" else { return nil }
        let run = t.prefix(while: { $0 == first })
        guard run.count >= 3 else { return nil }
        let info = String(t.dropFirst(run.count)).trimmingCharacters(in: .whitespaces)
        return (first, run.count, info)
    }

    private static func heading(_ t: String) -> (level: Int, text: String)? {
        let hashes = t.prefix(while: { $0 == "#" })
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = t.dropFirst(hashes.count)
        guard rest.first == " " else { return nil }
        return (hashes.count, String(rest).trimmingCharacters(in: .whitespaces))
    }

    private static func listItem(_ t: String) -> (marker: Character, text: String)? {
        guard let marker = t.first, marker == "*" || marker == "-" || marker == "+" else { return nil }
        let rest = t.dropFirst()
        guard rest.first == " " else { return nil }
        return (marker, String(rest).trimmingCharacters(in: .whitespaces))
    }

    private static func embed(_ t: String) -> (href: String, alt: String?, form: EmbedForm)? {
        if t.hasPrefix("![[") && t.hasSuffix("]]") {
            let body = String(t.dropFirst(3).dropLast(2))
            if let bar = body.firstIndex(of: "|") {
                return (String(body[body.startIndex..<bar]),
                        String(body[body.index(after: bar)...]), .wiki)
            }
            return (body, nil, .wiki)
        }
        guard t.hasPrefix("!["), t.hasSuffix(")"),
              let close = t.firstIndex(of: "]"),
              t.index(after: close) < t.endIndex,
              t[t.index(after: close)] == "(" else { return nil }
        let alt = String(t[t.index(t.startIndex, offsetBy: 2)..<close])
        let href = String(t[t.index(close, offsetBy: 2)..<t.index(before: t.endIndex)])
        return (href, alt.isEmpty ? nil : alt, .inline)
    }

    // MARK: - Serializing

    public static func serialize(_ doc: BookDocument) -> String {
        var out: [String] = ["---"]
        out.append("pagetile-book: true")
        out.append("title: \(doc.metadata.title)")
        if let a = doc.metadata.author { out.append("author: \(a)") }
        if let t = doc.metadata.translator { out.append("translator: \(t)") }
        out.append("lang: \(doc.metadata.lang)")
        out.append("direction: \(doc.metadata.direction)")
        if let c = doc.metadata.cover { out.append("cover: \(c)") }
        for e in doc.metadata.extras where e.key != "pagetile-book" {
            out.append("\(e.key): \(e.value)")
        }
        out.append("---")
        out.append("")

        out.append(contentsOf: render(doc.preamble))
        for chapter in doc.chapters {
            out.append(String(repeating: "#", count: chapter.level) + " " + chapter.title)
            out.append("")
            out.append(contentsOf: render(chapter.blocks))
        }
        // One trailing newline, never a run of blank lines: that normalization is
        // what makes the second serialize a fixpoint.
        while out.last == "" { out.removeLast() }
        return out.joined(separator: "\n") + "\n"
    }

    private static func render(_ blocks: [BookBlock], prefix: String = "") -> [String] {
        var out: [String] = []
        for block in blocks {
            switch block {
            case let .heading(level, text):
                out.append(prefix + String(repeating: "#", count: level) + " " + text)
            case let .paragraph(text):
                out.append(prefix + text)
            case let .quote(inner):
                let rendered = render(inner)
                for line in rendered {
                    out.append(line.isEmpty ? prefix + ">" : prefix + "> " + line)
                }
            case let .list(marker, items):
                for item in items { out.append(prefix + String(marker) + " " + item) }
            case let .image(href, alt, form):
                switch form {
                case .wiki:
                    out.append(prefix + "![[" + href + (alt.map { "|" + $0 } ?? "") + "]]")
                case .inline:
                    out.append(prefix + "![" + (alt ?? "") + "](" + href + ")")
                }
            case let .fence(char, info, lines):
                let bar = String(repeating: String(char), count: 3)
                out.append(prefix + bar + info)
                out.append(contentsOf: lines.map { prefix + $0 })
                out.append(prefix + bar)
            }
            out.append("")
        }
        return out
    }
}
