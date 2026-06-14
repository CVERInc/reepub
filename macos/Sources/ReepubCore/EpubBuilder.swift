import Foundation
import AppKit
import CoreGraphics

public struct EpubMetadata {
    public var title: String
    public var author: String  // optional; empty omits <dc:creator>
    public init(title: String, author: String) {
        self.title = title
        self.author = author
    }
}

struct Paragraph {
    let text: String
    let isHeading: Bool
}

enum Chapter {
    case text(title: String, paragraphs: [Paragraph])
    case image(title: String, imageRelPath: String, pageIndex: Int)
}

/// EPUB build failures. The associated value carries the underlying detail; the
/// localized message is composed at the UI layer (ContentView) so this type
/// stays free of presentation/locale concerns.
public enum EpubError: LocalizedError {
    case zipFailed(String)
    case validation(String)
    case io(String)

    public var errorDescription: String? {
        switch self {
        case .zipFailed(let m): return "EPUB packaging failed: \(m)"
        case .validation(let m): return "EPUB validation failed: \(m)"
        case .io(let m): return "Failed to write file: \(m)"
        }
    }
}

/// A structured build-progress stage emitted by `EpubBuilder.build`. The UI
/// renders these into localized, count-aware status text.
public enum BuildStage {
    case writingCover
    case writingChapters(Int)
    case validatingXML
    case packaging
}

private extension Character {
    var isLatinAlnum: Bool {
        ("a"..."z").contains(self) || ("A"..."Z").contains(self) || ("0"..."9").contains(self)
    }
}

/// Ports the EPUB-assembly logic from src/builder.js so the native app produces
/// the same reflowable EPUB3 as the Node CLI. Keep the heuristics in sync.
public enum EpubBuilder {

    // MARK: Text reconstruction

    static func joinText(_ lines: [OCRLine]) -> String {
        var result = ""
        for line in lines {
            let text = line.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if result.isEmpty { result = text; continue }
            guard let firstChar = text.first, let lastChar = result.last else { continue }
            if lastChar.isLatinAlnum && firstChar.isLatinAlnum {
                result += " " + text
            } else {
                result += text
            }
        }
        return result
    }

    private static let breakPunct: Set<Character> = ["。", "！", "？", "?", "」", "「", "”", "“", ".", "!"]

    private static func endsWithBreakPunct(_ s: String) -> Bool {
        guard let last = s.trimmingCharacters(in: .whitespacesAndNewlines).last else { return false }
        return breakPunct.contains(last)
    }

    static func processPage(_ page: OCRPage) -> [Paragraph] {
        let lines = page.lines
        if lines.isEmpty { return [] }

        // Drop top header (y > 0.94) and bottom footer/page-number (y < 0.06).
        let filtered = lines.filter { $0.y <= 0.94 && $0.y >= 0.06 }
        if filtered.isEmpty { return [] }

        let avgHeight = filtered.reduce(0.0) { $0 + $1.height } / Double(filtered.count)

        var paragraphs: [[OCRLine]] = []
        var current: [OCRLine] = []

        for line in filtered {
            guard let prev = current.last else { current.append(line); continue }
            let gap = prev.y - (line.y + line.height)
            var isBreak = false
            if gap > avgHeight * 1.8 {
                isBreak = true
            } else if endsWithBreakPunct(prev.text) && gap > avgHeight * 0.95 {
                isBreak = true
            } else if line.x - prev.x > 0.05 {
                isBreak = true
            } else if prev.height > avgHeight * 1.45 || line.height > avgHeight * 1.45 {
                isBreak = true
            }
            if isBreak {
                paragraphs.append(current)
                current = [line]
            } else {
                current.append(line)
            }
        }
        if !current.isEmpty { paragraphs.append(current) }

        return paragraphs.map { pLines -> Paragraph in
            let text = joinText(pLines)
            let isHeading = pLines.count == 1 && pLines[0].height > avgHeight * 1.35 && text.count < 40
            return Paragraph(text: text, isHeading: isHeading)
        }
    }

    // MARK: Chapter structuring

    static func structureChapters(_ pages: [OCRPage]) -> [Chapter] {
        var chapters: [Chapter] = []
        var currentTitle = "前言 / 開始閱讀"
        var currentParas: [Paragraph] = []

        for (idx, page) in pages.enumerated() {
            if page.type == "image" {
                if idx == 0 { continue }  // first page is the cover; handled separately
                if !currentParas.isEmpty {
                    chapters.append(.text(title: currentTitle, paragraphs: currentParas))
                    currentParas = []
                }
                chapters.append(.image(title: "插圖 (頁 \(idx + 1))",
                                       imageRelPath: "images/page_\(idx + 1).jpeg",
                                       pageIndex: idx))
                currentTitle = "第 \(chapters.count + 1) 部分 (頁 \(idx + 1))"
                currentParas = []
                continue
            }

            for p in processPage(page) {
                let lower = p.text.lowercased()
                let isChStart = p.isHeading && (
                    p.text.contains("章") ||
                    lower.contains("chapter") ||
                    p.text.contains("第一") || p.text.contains("第二") || p.text.contains("第三") ||
                    p.text.contains("第四") || p.text.contains("第五") || p.text.contains("第六")
                )
                if isChStart && !currentParas.isEmpty {
                    chapters.append(.text(title: currentTitle, paragraphs: currentParas))
                    currentTitle = p.text
                    currentParas = []
                } else if currentParas.count > 90 {
                    chapters.append(.text(title: currentTitle, paragraphs: currentParas))
                    currentTitle = "第 \(chapters.count + 1) 部分 (頁 \(idx + 1))"
                    currentParas = []
                }
                currentParas.append(p)
            }
        }
        if !currentParas.isEmpty {
            chapters.append(.text(title: currentTitle, paragraphs: currentParas))
        }
        return chapters
    }

    // MARK: Helpers

    private static func escapeXML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    private static func escapeAmp(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
    }

    private static func jpegData(from cgImage: CGImage, compression: CGFloat = 0.8) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        return rep.representation(using: .jpeg, properties: [.compressionFactor: compression])
    }

    // MARK: Build

    /// Build a validated EPUB3 from OCR'd pages and write it to `outputURL`.
    /// `progress` reports the current stage (called on a background queue).
    public static func build(pages: [OCRPage], metadata: EpubMetadata, outputURL: URL,
                      progress: ((BuildStage) -> Void)? = nil) throws {
        let fm = FileManager.default
        let tempDir = fm.temporaryDirectory.appendingPathComponent("reepub-build-\(UUID().uuidString)")
        let oebps = tempDir.appendingPathComponent("OEBPS")
        let chaptersDir = oebps.appendingPathComponent("chapters")
        let imagesDir = oebps.appendingPathComponent("images")
        let metaInf = tempDir.appendingPathComponent("META-INF")

        defer { try? fm.removeItem(at: tempDir) }

        do {
            for dir in [metaInf, chaptersDir, imagesDir] {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }

            // mimetype + container
            try "application/epub+zip".write(to: tempDir.appendingPathComponent("mimetype"),
                                             atomically: true, encoding: .utf8)
            try containerXML.write(to: metaInf.appendingPathComponent("container.xml"),
                                   atomically: true, encoding: .utf8)
            try styleCSS.write(to: oebps.appendingPathComponent("style.css"),
                               atomically: true, encoding: .utf8)

            // Cover (page 0)
            progress?(.writingCover)
            var hasCover = false
            if let first = pages.first?.image, let data = jpegData(from: first) {
                try data.write(to: imagesDir.appendingPathComponent("cover.jpeg"))
                hasCover = true
            }

            let chapters = structureChapters(pages)

            // Image-page plates
            for chapter in chapters {
                if case let .image(_, imageRelPath, pageIndex) = chapter,
                   pageIndex < pages.count, let img = pages[pageIndex].image,
                   let data = jpegData(from: img) {
                    let name = (imageRelPath as NSString).lastPathComponent
                    try data.write(to: imagesDir.appendingPathComponent(name))
                }
            }

            // Per-chapter XHTML
            progress?(.writingChapters(chapters.count))
            struct ManifestItem { let id: String; let title: String; let href: String }
            var manifestChapters: [ManifestItem] = []

            for (idx, chapter) in chapters.enumerated() {
                let pad = String(format: "ch%02d", idx + 1)
                let fileName = "\(pad).xhtml"
                let xhtml: String
                let title: String

                switch chapter {
                case let .image(t, imageRelPath, _):
                    title = t
                    xhtml = imageChapterXHTML(title: t, imageRelPath: imageRelPath)
                case let .text(t, paragraphs):
                    title = t
                    xhtml = textChapterXHTML(title: t, paragraphs: paragraphs)
                }

                try xhtml.write(to: chaptersDir.appendingPathComponent(fileName),
                                atomically: true, encoding: .utf8)
                manifestChapters.append(ManifestItem(id: pad, title: title,
                                                     href: "chapters/\(fileName)"))
            }

            // cover.xhtml
            if hasCover {
                try coverXHTML(title: metadata.title)
                    .write(to: oebps.appendingPathComponent("cover.xhtml"),
                           atomically: true, encoding: .utf8)
            }

            // index.xhtml (TOC page)
            try indexXHTML(title: metadata.title, chapters: manifestChapters.map { ($0.title, $0.href) })
                .write(to: oebps.appendingPathComponent("index.xhtml"),
                       atomically: true, encoding: .utf8)

            // content.opf
            let imageItems: [(String, String)] = chapters.enumerated().compactMap { idx, ch in
                if case let .image(_, imageRelPath, _) = ch {
                    return ("page-img-\(idx + 1)", imageRelPath)
                }
                return nil
            }
            try contentOPF(metadata: metadata, hasCover: hasCover,
                           imageItems: imageItems,
                           chapters: manifestChapters.map { ($0.id, $0.href) })
                .write(to: oebps.appendingPathComponent("content.opf"),
                       atomically: true, encoding: .utf8)

            // toc.ncx
            try tocNCX(title: metadata.title, chapters: manifestChapters.map { ($0.id, $0.title, $0.href) })
                .write(to: oebps.appendingPathComponent("toc.ncx"),
                       atomically: true, encoding: .utf8)

            // Validate well-formedness of generated XML before packaging.
            progress?(.validatingXML)
            try validateXML(in: oebps)

            // Package: mimetype stored (uncompressed) first, then the rest deflated.
            progress?(.packaging)
            if fm.fileExists(atPath: outputURL.path) {
                try fm.removeItem(at: outputURL)
            }
            try runZip(["-0Xq", outputURL.path, "mimetype"], cwd: tempDir)
            try runZip(["-ur9q", outputURL.path, "META-INF", "OEBPS"], cwd: tempDir)
        } catch let e as EpubError {
            throw e
        } catch {
            throw EpubError.io(error.localizedDescription)
        }
    }

    private static func validateXML(in oebps: URL) throws {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(at: oebps, includingPropertiesForKeys: nil) else { return }
        for case let url as URL in enumerator {
            let ext = url.pathExtension.lowercased()
            guard ["xhtml", "opf", "ncx", "xml"].contains(ext) else { continue }
            do {
                _ = try XMLDocument(contentsOf: url, options: [])
            } catch {
                throw EpubError.validation("\(url.lastPathComponent)：\(error.localizedDescription)")
            }
        }
    }

    private static func runZip(_ args: [String], cwd: URL) throws {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        proc.arguments = args
        proc.currentDirectoryURL = cwd
        let errPipe = Pipe()
        proc.standardError = errPipe
        proc.standardOutput = Pipe()
        try proc.run()
        proc.waitUntilExit()
        if proc.terminationStatus != 0 {
            let msg = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw EpubError.zipFailed(msg.isEmpty ? "exit \(proc.terminationStatus)" : msg)
        }
    }

    // MARK: Templates (ported verbatim from src/builder.js)

    private static let containerXML = """
    <?xml version="1.0" encoding="UTF-8"?>
    <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
      <rootfiles>
        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
      </rootfiles>
    </container>
    """

    private static let styleCSS = """
    /* Stylesheet for scanned EPUB */
    body {
      font-family: serif;
      line-height: 1.6;
      margin: 0;
      padding: 10px;
    }
    h1, h2, h3 {
      font-family: sans-serif;
      text-align: center;
      margin-top: 1.2em;
      margin-bottom: 0.6em;
    }
    h2 {
      font-size: 1.4em;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 5px;
    }
    p {
      margin-bottom: 1.2em;
      text-indent: 2em; /* Chinese paragraph indentation */
    }
    p.heading-p {
      text-indent: 0;
      text-align: center;
      font-weight: bold;
    }
    img.cover {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 0 auto;
    }
    """

    private static func textChapterXHTML(title: String, paragraphs: [Paragraph]) -> String {
        let body = paragraphs.map { p -> String in
            let t = escapeXML(p.text)
            return p.isHeading ? "  <h2>\(t)</h2>" : "  <p>\(t)</p>"
        }.joined(separator: "\n")

        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
        <head>
          <meta charset="UTF-8" />
          <title>\(escapeXML(title))</title>
          <link rel="stylesheet" href="../style.css" type="text/css" />
        </head>
        <body>
          <h1>\(escapeXML(title))</h1>
          <hr />
        \(body)
        </body>
        </html>
        """
    }

    private static func imageChapterXHTML(title: String, imageRelPath: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
        <head>
          <meta charset="UTF-8" />
          <title>\(escapeXML(title))</title>
        </head>
        <body style="margin: 0; padding: 0; text-align: center; background-color: #ffffff;">
          <div class="cover-container" style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
            <img class="cover-image" src="../\(imageRelPath)" alt="\(escapeXML(title))" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
          </div>
        </body>
        </html>
        """
    }

    private static func coverXHTML(title: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
        <head>
          <meta charset="UTF-8" />
          <title>Cover</title>
        </head>
        <body style="margin: 0; padding: 0; text-align: center; background-color: #ffffff;">
          <div class="cover-container" style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
            <img class="cover-image" src="images/cover.jpeg" alt="\(escapeXML(title))" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
          </div>
        </body>
        </html>
        """
    }

    private static func indexXHTML(title: String, chapters: [(String, String)]) -> String {
        let items = chapters.map { "    <li><a href=\"\($0.1)\">\(escapeXML($0.0))</a></li>" }
            .joined(separator: "\n")
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
        <head>
          <meta charset="UTF-8" />
          <title>\(escapeXML(title)) - 目錄</title>
          <link rel="stylesheet" href="style.css" type="text/css" />
        </head>
        <body>
          <h1>目錄</h1>
          <hr />
          <ul>
        \(items)
          </ul>
        </body>
        </html>
        """
    }

    private static func contentOPF(metadata: EpubMetadata, hasCover: Bool,
                                   imageItems: [(String, String)],
                                   chapters: [(String, String)]) -> String {
        let creator = metadata.author.isEmpty ? "" :
            "\n    <dc:creator>\(escapeAmp(metadata.author))</dc:creator>"
        let coverMeta = hasCover ? "\n    <meta name=\"cover\" content=\"cover-image\"/>" : ""
        let timestamp = String(Int(Date().timeIntervalSince1970 * 1000))

        var manifest = [
            "    <item id=\"style\" href=\"style.css\" media-type=\"text/css\"/>",
            "    <item id=\"index\" href=\"index.xhtml\" media-type=\"application/xhtml+xml\"/>",
        ]
        if hasCover {
            manifest.append("    <item id=\"cover-image\" href=\"images/cover.jpeg\" media-type=\"image/jpeg\"/>")
            manifest.append("    <item id=\"cover-xhtml\" href=\"cover.xhtml\" media-type=\"application/xhtml+xml\"/>")
        }
        for (id, href) in imageItems {
            manifest.append("    <item id=\"\(id)\" href=\"\(href)\" media-type=\"image/jpeg\"/>")
        }
        for (id, href) in chapters {
            manifest.append("    <item id=\"\(id)\" href=\"\(href)\" media-type=\"application/xhtml+xml\"/>")
        }
        manifest.append("    <item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>")

        var spine: [String] = []
        if hasCover { spine.append("    <itemref idref=\"cover-xhtml\"/>") }
        spine.append("    <itemref idref=\"index\"/>")
        for (id, _) in chapters { spine.append("    <itemref idref=\"\(id)\"/>") }

        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>\(escapeAmp(metadata.title))</dc:title>\(creator)
            <dc:language>zh-Hant</dc:language>
            <dc:identifier id="BookID">urn:uuid:ocr-book-\(timestamp)</dc:identifier>
            <meta property="dcterms:modified">\(isoTimestamp())</meta>\(coverMeta)
          </metadata>
          <manifest>
        \(manifest.joined(separator: "\n"))
          </manifest>
          <spine toc="ncx">
        \(spine.joined(separator: "\n"))
          </spine>
        </package>
        """
    }

    private static func tocNCX(title: String, chapters: [(String, String, String)]) -> String {
        let navPoints = chapters.enumerated().map { idx, ch -> String in
            """
                <navPoint id="navPoint-\(ch.0)" playOrder="\(idx + 2)">
                  <navLabel><text>\(escapeXML(ch.1))</text></navLabel>
                  <content src="\(ch.2)"/>
                </navPoint>
            """
        }.joined(separator: "\n")
        let timestamp = String(Int(Date().timeIntervalSince1970 * 1000))

        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
          <head>
            <meta name="dtb:uid" content="urn:uuid:ocr-book-\(timestamp)"/>
            <meta name="dtb:depth" content="1"/>
            <meta name="dtb:totalPageCount" content="0"/>
            <meta name="dtb:maxPageNumber" content="0"/>
          </head>
          <docTitle>
            <text>\(escapeXML(title))</text>
          </docTitle>
          <navMap>
            <navPoint id="navPoint-index" playOrder="1">
              <navLabel><text>目錄</text></navLabel>
              <content src="index.xhtml"/>
            </navPoint>
        \(navPoints)
          </navMap>
        </ncx>
        """
    }

    private static func isoTimestamp() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        return f.string(from: Date())
    }
}
