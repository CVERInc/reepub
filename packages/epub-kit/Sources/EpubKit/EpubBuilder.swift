// sync-marker: v1
// Kept behaviorally in sync with src/builder.js / src/epub-text.js (joinText /
// processPage / structureChapters / XML escaping). scripts/check-sync-markers.mjs
// re-derives the shared heuristics — break punctuation, the heading length metric,
// the paragraph-geometry thresholds and the escape table — from both sources on
// every CI run, so a divergence fails the build instead of shipping two different
// books from one PDF.
import Foundation
import AppKit
import CoreGraphics
import ScanOCR

public struct EpubMetadata {
    public var title: String
    public var author: String  // optional; empty omits <dc:creator>
    public init(title: String, author: String) {
        self.title = title
        self.author = author
    }
}

/// Choices the person binding the book gets to make, with the safe answer as
/// the default. Kept apart from EpubMetadata: the metadata describes the book,
/// these describe the binding.
public struct EpubOptions {
    /// A Kindle silently refuses to show the cover or the table of contents of
    /// a book whose text contains pictographic emoji — the whole book, not the
    /// chapter carrying them — while the file validates clean. Found by
    /// bisection over ~40 builds on the device; src/epub-text.js documents the
    /// evidence. On by default because a book that hides its own cover is
    /// broken in the way the reader actually meets; the switch exists because
    /// it is the reader's book, and a reader who never sends it to a Kindle
    /// loses nothing by keeping the emoji.
    public var removePictographs: Bool
    public init(removePictographs: Bool = true) {
        self.removePictographs = removePictographs
    }
}

/// What the build did beyond assembling — the app surfaces this, so a repair
/// is named to the person whose book it is rather than done quietly.
public struct BuildReport {
    public var pictographsRemoved: Int
    /// Image hrefs the document asked for and the build could not find.
    ///
    /// Named rather than fatal, and named rather than silent. A book that lost
    /// thirty images without a word is what put this here (docs/data-not-format.md,
    /// "The tool reports; the owner decides") — refusing to build would be the
    /// converter deciding the image mattered, and saying nothing would be it
    /// deciding the image did not.
    public var imagesNotFound: [String]
    public init(pictographsRemoved: Int = 0, imagesNotFound: [String] = []) {
        self.pictographsRemoved = pictographsRemoved
        self.imagesNotFound = imagesNotFound
    }
}

struct Paragraph {
    let text: String
    let isHeading: Bool
    /// Set when this run of the chapter is an image rather than prose.
    ///
    /// OCR never produces one: a scanned page is either text or a plate, and a
    /// plate is a whole chapter. A book that arrives as markdown does — an
    /// illustration sits between two paragraphs and belongs there. `text` stays
    /// the alt text, so a reader that cannot show the image still gets what it
    /// said.
    let imageRelPath: String?

    init(text: String, isHeading: Bool, imageRelPath: String? = nil) {
        self.text = text
        self.isHeading = isHeading
        self.imageRelPath = imageRelPath
    }
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

    /// Must stay character-for-character identical to the class in src/epub-text.js.
    /// 「 and “ are *opening* quotes: a line that ends in one is handing the next
    /// line over to a speaker, so it genuinely starts a new paragraph.
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
            // String.count is extended grapheme clusters; src/epub-text.js mirrors it
            // with Intl.Segmenter, never String#length (UTF-16 code units).
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

    /// Escape text destined for XML/XHTML *element content* (&, <, >). Used
    /// everywhere user- or OCR-derived text lands inside a tag, including
    /// <dc:title>/<dc:creator>: a title like "A <B>" would otherwise produce
    /// malformed XML that the validator then rejects.
    static func escapeXML(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }

    /// Escape text destined for an XML *attribute value* (adds " on top of the
    /// element-content escaping) so a quote can't close the attribute early.
    static func escapeAttr(_ s: String) -> String {
        escapeXML(s).replacingOccurrences(of: "\"", with: "&quot;")
    }

    // MARK: Pictographs

    /// Must stay numerically identical to PICTOGRAPH in src/epub-text.js. The
    /// range stops short of U+20000 where CJK Extension B lives — a book must
    /// never lose a character of its own language to this — and arrows,
    /// bullets and ticks (all below U+1F000) stay, so a diagram of boxes and
    /// arrows still reads as one.
    static let pictographRange: ClosedRange<UInt32> = 0x1F000...0x1FAFF
    static let variationSelector: UInt32 = 0xFE0F

    private static func isPictograph(_ scalar: Unicode.Scalar) -> Bool {
        pictographRange.contains(scalar.value)
    }

    static func countPictographs(_ text: String) -> Int {
        text.unicodeScalars.reduce(0) { $0 + (isPictograph($1) ? 1 : 0) }
    }

    /// Mirror of stripPictographs in src/epub-text.js: "🧠 概念圖解" becomes
    /// "概念圖解", not " 概念圖解" — an icon at the head of a label takes its
    /// separating space with it; one that sat between words keeps a single
    /// space, so the words on either side do not run together.
    static func stripPictographs(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        var pendingSpace: [Unicode.Scalar] = []  // whitespace not yet attributed to a run
        var inRun = false
        var spaceBeforeRun = false

        // Leaving a run: the run and its surrounding whitespace collapse to one
        // space iff there was whitespace on both sides, exactly as the JS
        // replacement of /\s*(pictograph)+\s*/ does.
        func endRun() {
            guard inRun else { return }
            if spaceBeforeRun && !pendingSpace.isEmpty { out.append(" ") }
            pendingSpace.removeAll()
            inRun = false
            spaceBeforeRun = false
        }

        for scalar in text.unicodeScalars {
            if isPictograph(scalar) || (inRun && scalar.value == variationSelector) {
                if inRun {
                    pendingSpace.removeAll()  // whitespace between pictographs is interior: swallowed
                } else {
                    inRun = true
                    spaceBeforeRun = !pendingSpace.isEmpty
                    pendingSpace.removeAll()
                }
                continue
            }
            if scalar.properties.isWhitespace {
                pendingSpace.append(scalar)
                continue
            }
            endRun()
            out.append(contentsOf: pendingSpace)
            pendingSpace.removeAll()
            out.append(scalar)
        }
        endRun()
        out.append(contentsOf: pendingSpace)
        return String(out)
    }

    private static func jpegData(from cgImage: CGImage, compression: CGFloat = 0.8) -> Data? {
        let rep = NSBitmapImageRep(cgImage: cgImage)
        return rep.representation(using: .jpeg, properties: [.compressionFactor: compression])
    }

    // MARK: Build

    /// Build a validated EPUB3 from OCR'd pages and write it to `outputURL`.
    /// `progress` reports the current stage (called on a background queue).
    /// The returned report names anything the build changed beyond assembling.
    @discardableResult
    public static func build(pages: [OCRPage], metadata: EpubMetadata, outputURL: URL,
                      options: EpubOptions = EpubOptions(),
                      progress: ((BuildStage) -> Void)? = nil) throws -> BuildReport {
        // The OCR path is now one caller of the assembler rather than the
        // assembler itself. Three things tied them together — where the cover
        // came from, how chapters were structured, and where a plate's bytes
        // lived — and all three are now the caller's to answer. Nothing about
        // the package document, the navigation document or the chapter XHTML
        // knew about OCR; only these did.
        return try assemble(
            chapters: structureChapters(pages),
            coverJPEG: pages.first?.image.flatMap { jpegData(from: $0) },
            imageJPEG: { chapter in
                guard case let .image(_, _, pageIndex) = chapter,
                      pageIndex < pages.count, let img = pages[pageIndex].image else { return nil }
                return jpegData(from: img)
            },
            metadata: metadata, outputURL: outputURL, options: options, progress: progress)
    }

    /// Build a book that already exists as chapters — the markdown path.
    ///
    /// `imagesDirectory` is where the hrefs in the document resolve. A missing
    /// file is reported in `BuildReport.imagesNotFound` and the book is built
    /// without it: a reference that resolves to nothing is a broken book, and
    /// naming which one beats refusing to build at all.
    @discardableResult
    public static func build(document: BookDocument, metadata: EpubMetadata, outputURL: URL,
                             imagesDirectory: URL?, coverImageURL: URL? = nil,
                             options: EpubOptions = EpubOptions(),
                             progress: ((BuildStage) -> Void)? = nil) throws -> BuildReport {
        var missing: [String] = []
        let chapters = document.chapters.map { chapter -> Chapter in
            .text(title: chapter.title, paragraphs: paragraphs(of: chapter.blocks))
        }
        // Images are inline in a markdown book, so they are copied by href
        // rather than looked up per chapter.
        var byHref: [String: Data] = [:]
        for chapter in document.chapters {
            for href in imageHrefs(of: chapter.blocks) {
                guard byHref[href] == nil else { continue }
                guard let dir = imagesDirectory,
                      let data = try? Data(contentsOf: dir.appendingPathComponent((href as NSString).lastPathComponent))
                else { missing.append(href); continue }
                byHref[href] = data
            }
        }
        var report = try assemble(
            chapters: chapters,
            coverJPEG: coverImageURL.flatMap { try? Data(contentsOf: $0) },
            imageJPEG: { _ in nil },
            inlineImages: byHref,
            metadata: metadata, outputURL: outputURL, options: options, progress: progress)
        report.imagesNotFound = missing
        return report
    }

    private static func paragraphs(of blocks: [BookBlock]) -> [Paragraph] {
        var out: [Paragraph] = []
        for block in blocks {
            switch block {
            case let .paragraph(text):
                out.append(Paragraph(text: text, isHeading: false))
            case let .heading(_, text):
                out.append(Paragraph(text: text, isHeading: true))
            case let .list(_, items):
                // No list element in the OCR model, and inventing one here
                // would put a second opinion about chapter XHTML in the repo.
                // The items keep their order and their text, which is what the
                // ledger calls data.
                for item in items { out.append(Paragraph(text: item, isHeading: false)) }
            case let .quote(inner):
                out.append(contentsOf: paragraphs(of: inner))
            case let .image(href, alt, _):
                out.append(Paragraph(text: alt ?? "", isHeading: false,
                                     imageRelPath: "images/\((href as NSString).lastPathComponent)"))
            case .fence:
                continue
            }
        }
        return out
    }

    private static func imageHrefs(of blocks: [BookBlock]) -> [String] {
        var out: [String] = []
        for block in blocks {
            switch block {
            case let .image(href, _, _): out.append(href)
            case let .quote(inner): out.append(contentsOf: imageHrefs(of: inner))
            default: continue
            }
        }
        return out
    }

    @discardableResult
    private static func assemble(chapters chaptersIn: [Chapter],
                                 coverJPEG: Data?,
                                 imageJPEG: (Chapter) -> Data?,
                                 inlineImages: [String: Data] = [:],
                                 metadata: EpubMetadata, outputURL: URL,
                                 options: EpubOptions,
                                 progress: ((BuildStage) -> Void)?) throws -> BuildReport {
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

            // Cover
            progress?(.writingCover)
            var hasCover = false
            if let data = coverJPEG {
                try data.write(to: imagesDir.appendingPathComponent("cover.jpeg"))
                hasCover = true
            }

            // Images referenced from inside a chapter, written before the
            // chapters so a manifest entry never names a file that is not there.
            for (href, data) in inlineImages {
                try data.write(to: imagesDir.appendingPathComponent((href as NSString).lastPathComponent))
            }

            var chapters = chaptersIn
            var report = BuildReport()

            // The reader's choice, made after the chapters are structured so
            // the geometry heuristics never see a text that differs from what
            // the OCR produced.
            if options.removePictographs {
                chapters = chapters.map { chapter in
                    switch chapter {
                    case let .text(title, paragraphs):
                        report.pictographsRemoved += countPictographs(title)
                            + paragraphs.reduce(0) { $0 + countPictographs($1.text) }
                        return .text(title: stripPictographs(title),
                                     paragraphs: paragraphs.map {
                                         Paragraph(text: stripPictographs($0.text), isHeading: $0.isHeading)
                                     })
                    case let .image(title, imageRelPath, pageIndex):
                        report.pictographsRemoved += countPictographs(title)
                        return .image(title: stripPictographs(title),
                                      imageRelPath: imageRelPath, pageIndex: pageIndex)
                    }
                }
            }

            // One identifier for the whole book. The OPF and the NCX used to
            // mint their own timestamps — two documents disagreeing about which
            // book they describe, and neither a valid UUID.
            let bookUUID = UUID().uuidString.lowercased()

            // Image-page plates
            for chapter in chapters {
                if case let .image(_, imageRelPath, _) = chapter, let data = imageJPEG(chapter) {
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

            // nav.xhtml — the navigation document EPUB 3 requires. Manifested
            // with properties="nav" but kept out of the spine, matching the
            // Node binder: the book's own index page is what a reader pages
            // through; this one is for the machine.
            try navXHTML(title: metadata.title, chapters: manifestChapters.map { ($0.title, $0.href) })
                .write(to: oebps.appendingPathComponent("nav.xhtml"),
                       atomically: true, encoding: .utf8)

            // content.opf
            let imageItems: [(String, String)] = chapters.enumerated().compactMap { idx, ch in
                if case let .image(_, imageRelPath, _) = ch {
                    return ("page-img-\(idx + 1)", imageRelPath)
                }
                return nil
            }
            // Inline images are manifested too. Every packaged file has to
            // appear in the manifest, and an image that is in the zip but not
            // the manifest is an OPF-014 the moment epubcheck sees it.
            let inlineItems: [(String, String)] = inlineImages.keys.sorted().enumerated().map { idx, href in
                ("inline-img-\(idx + 1)", "images/\((href as NSString).lastPathComponent)")
            }
            try contentOPF(metadata: metadata, uuid: bookUUID, hasCover: hasCover,
                           imageItems: imageItems + inlineItems,
                           chapters: manifestChapters.map { ($0.id, $0.href) })
                .write(to: oebps.appendingPathComponent("content.opf"),
                       atomically: true, encoding: .utf8)

            // toc.ncx
            try tocNCX(title: metadata.title, uuid: bookUUID,
                       chapters: manifestChapters.map { ($0.id, $0.title, $0.href) })
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
            return report
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
            // Inline markup is the format's own business, so BookMarkdown
            // renders it. OCR text has none and comes back escaped and
            // unchanged, which is why this is safe on both paths.
            let t = BookMarkdown.inlineXHTML(p.text)
            if let href = p.imageRelPath {
                return "  <p class=\"reepub-figure\">"
                    + "<img src=\"../\(escapeAttr(href))\" alt=\"\(escapeAttr(p.text))\" />"
                    + "</p>"
            }
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

    /// The `oeb-page-*-margin` resets are not CSS3 — they are the OEB properties
    /// Kindle's converter honours, and without them a full-bleed plate is inset by
    /// the device's default page margins. Other readers ignore the unknown
    /// properties, so they cost nothing. Keep them identical to src/builder.js.
    private static let fullBleedBodyStyle =
        "margin: 0; padding: 0; text-align: center; background-color: #ffffff; "
        + "oeb-page-head-margin: 0 !important; oeb-page-foot-margin: 0 !important; "
        + "oeb-page-left-margin: 0 !important; oeb-page-right-margin: 0 !important;"

    private static func imageChapterXHTML(title: String, imageRelPath: String) -> String {
        """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
        <head>
          <meta charset="UTF-8" />
          <title>\(escapeXML(title))</title>
        </head>
        <body style="\(fullBleedBodyStyle)">
          <div class="cover-container" style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
            <img class="cover-image" src="../\(imageRelPath)" alt="\(escapeAttr(title))" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
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
        <body style="\(fullBleedBodyStyle)">
          <div class="cover-container" style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
            <img class="cover-image" src="images/cover.jpeg" alt="\(escapeAttr(title))" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
          </div>
        </body>
        </html>
        """
    }

    private static func indexXHTML(title: String, chapters: [(String, String)]) -> String {
        let items = chapters.map { "    <li><a href=\"\(escapeAttr($0.1))\">\(escapeXML($0.0))</a></li>" }
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

    private static func contentOPF(metadata: EpubMetadata, uuid: String, hasCover: Bool,
                                   imageItems: [(String, String)],
                                   chapters: [(String, String)]) -> String {
        let creator = metadata.author.isEmpty ? "" :
            "\n    <dc:creator>\(escapeXML(metadata.author))</dc:creator>"
        let coverMeta = hasCover ? "\n    <meta name=\"cover\" content=\"cover-image\"/>" : ""

        var manifest = [
            "    <item id=\"style\" href=\"style.css\" media-type=\"text/css\"/>",
            "    <item id=\"index\" href=\"index.xhtml\" media-type=\"application/xhtml+xml\"/>",
            "    <item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>",
        ]
        if hasCover {
            manifest.append("    <item id=\"cover-image\" href=\"images/cover.jpeg\" media-type=\"image/jpeg\" properties=\"cover-image\"/>")
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
            <dc:title>\(escapeXML(metadata.title))</dc:title>\(creator)
            <dc:language>zh-Hant</dc:language>
            <dc:identifier id="BookID">urn:uuid:\(uuid)</dc:identifier>
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

    /// The EPUB 3 navigation document. Same entries as the NCX and the visible
    /// index page — three views of one truth, all built from one chapter list.
    private static func navXHTML(title: String, chapters: [(String, String)]) -> String {
        let items = chapters.map { "        <li><a href=\"\(escapeAttr($0.1))\">\(escapeXML($0.0))</a></li>" }
            .joined(separator: "\n")
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE html>
        <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-Hant" lang="zh-Hant">
        <head>
          <meta charset="UTF-8" />
          <title>\(escapeXML(title))</title>
        </head>
        <body>
          <nav epub:type="toc">
            <h1>目錄</h1>
            <ol>
        \(items)
            </ol>
          </nav>
        </body>
        </html>
        """
    }

    private static func tocNCX(title: String, uuid: String, chapters: [(String, String, String)]) -> String {
        let navPoints = chapters.enumerated().map { idx, ch -> String in
            """
                <navPoint id="navPoint-\(ch.0)" playOrder="\(idx + 2)">
                  <navLabel><text>\(escapeXML(ch.1))</text></navLabel>
                  <content src="\(escapeAttr(ch.2))"/>
                </navPoint>
            """
        }.joined(separator: "\n")

        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
          <head>
            <meta name="dtb:uid" content="urn:uuid:\(uuid)"/>
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
