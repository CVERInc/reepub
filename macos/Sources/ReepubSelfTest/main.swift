import Foundation
import AppKit
import PDFKit
import EpubKit
import ScanOCR

// Headless verification of OCREngine: render a known zh-Hant + en PDF, OCR it,
// and check the recognized text contains the expected strings.

func makeTestPDF(at url: URL) throws {
    var mediaBox = CGRect(x: 0, y: 0, width: 595, height: 842) // A4 in points
    guard let ctx = CGContext(url as CFURL, mediaBox: &mediaBox, nil) else {
        throw NSError(domain: "selftest", code: 1)
    }
    ctx.beginPDFPage(nil)
    let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns

    let text = "Reepub 測試文件\n第一章 開始\nHello World 你好世界\n這是一段用來驗證 OCR 的中文測試文字，內容刻意寫長一點，確保整頁辨識出來的字數超過一百二十字的門檻，這樣這一頁就會被判定為文字頁而不是圖片頁，於是組裝 EPUB 時就會真的產生章節的 XHTML 檔案，讓我們能夠驗證文字章節這條路徑確實有效運作。"
    let attrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 30),
        .foregroundColor: NSColor.black,
    ]
    NSAttributedString(string: text, attributes: attrs)
        .draw(in: CGRect(x: 60, y: 380, width: 475, height: 400))

    NSGraphicsContext.restoreGraphicsState()
    ctx.endPDFPage()
    ctx.closePDF()
}

let tmp = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("reepub-ocr-selftest.pdf")
try makeTestPDF(at: tmp)
FileHandle.standardError.write("Wrote test PDF: \(tmp.path)\n".data(using: .utf8)!)

let pages = try OCREngine.recognize(pdfURL: tmp, progress: { current, total in
    FileHandle.standardError.write("  OCR page \(current)/\(total)\n".data(using: .utf8)!)
})

let allLines = pages.flatMap { $0.lines.map { $0.text } }
print("pages = \(pages.count)")
print("recognized lines:")
for line in allLines { print("  • \(line)") }

let joined = allLines.joined()
let expectations = ["Reepub", "Hello", "World", "第一章", "你好", "中文"]
var failures = 0
print("checks:")
for expected in expectations {
    let ok = joined.contains(expected)
    print("  \(ok ? "✓" : "✗") \(expected)")
    if !ok { failures += 1 }
}

// Build an EPUB from the OCR'd pages and report where it landed.
let epubURL = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("reepub-selftest.epub")
do {
    try EpubBuilder.build(pages: pages,
                          metadata: EpubMetadata(title: "Reepub 自我測試", author: "CVER", language: "zh-Hant"),
                          outputURL: epubURL)
    let size = (try? FileManager.default.attributesOfItem(atPath: epubURL.path)[.size] as? Int) ?? 0
    print("\nEPUB built: \(epubURL.path) (\(size) bytes)")
} catch {
    print("\n[FAILURE] EPUB build failed: \(error.localizedDescription)")
    failures += 1
}

// --- XML-escaping regression test ---------------------------------------
// A title/author with XML-special characters (&, <, >, ") must not produce
// malformed OPF / NCX / XHTML. Build a tiny EPUB from a synthetic text page
// using a hostile title and assert the build (which validates XML before
// packaging) succeeds. Before the escaping fix this threw EpubError.validation.
print("\nXML-escaping regression test:")
do {
    let hostileTitle = "A <b> & \"Q\" > end"
    let hostileAuthor = "Tom & <Jerry>"
    let line = OCRLine(text: "這是一段足夠長的內文字，用來確保這一頁被當作文字頁處理，於是 EpubBuilder 會真的寫出章節 XHTML、OPF 與 NCX，讓我們能驗證標題與作者中的 XML 特殊字元都被正確跳脫。",
                       x: 0.1, y: 0.5, width: 0.8, height: 0.03)
    let page = OCRPage(pageIndex: 0, lines: [line], type: "text", image: nil)
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("reepub-escape-selftest.epub")
    try EpubBuilder.build(pages: [page],
                          metadata: EpubMetadata(title: hostileTitle, author: hostileAuthor, language: "zh-Hant"),
                          outputURL: url)
    print("  ✓ hostile title/author built without XML errors")
    try? FileManager.default.removeItem(at: url)
} catch {
    print("  ✗ hostile title/author build failed: \(error.localizedDescription)")
    failures += 1
}

// --- Emoji / package-conformance regression tests ------------------------
// The defect that cost ~40 device builds to find: a Kindle shows a book whose
// text contains pictographic emoji with no cover and no table of contents at
// all, while the file validates clean. Removal is the default and the reader
// can switch it off; both directions are asserted here, along with the
// package repairs (nav document, one valid UUID) the Node side already had.
print("\nEmoji + package conformance tests:")

func unzipRead(_ epub: URL, _ entry: String) -> String {
    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
    proc.arguments = ["-p", epub.path, entry]
    let out = Pipe()
    proc.standardOutput = out
    proc.standardError = Pipe()
    try? proc.run()
    proc.waitUntilExit()
    return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
}

do {
    let emojiLine = OCRLine(
        text: "🧠 概念圖解:很好 🚀 的想法,頂尖人才 → 卓越團隊,加上一段夠長的中文內文讓這一頁確定被判定為文字頁,於是章節、OPF、NCX 與導覽文件全部都會真的產生出來供我們檢查。",
        x: 0.1, y: 0.5, width: 0.8, height: 0.03)
    let page = OCRPage(pageIndex: 0, lines: [emojiLine], type: "text", image: nil)
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("reepub-emoji-selftest.epub")

    // Default: pictographs removed, and named in the report.
    let report = try EpubBuilder.build(pages: [page],
                                       metadata: EpubMetadata(title: "Emoji 測試", author: "", language: "zh-Hant"),
                                       outputURL: url)
    let chapter = unzipRead(url, "OEBPS/chapters/ch01.xhtml")
    let strippedOK = report.pictographsRemoved == 2
        && !chapter.unicodeScalars.contains { (0x1F000...0x1FAFF).contains($0.value) }
    print("  \(strippedOK ? "✓" : "✗") default build removes pictographs and reports the count (removed \(report.pictographsRemoved))")
    if !strippedOK { failures += 1 }

    let arrowsOK = chapter.contains("→") && chapter.contains("概念圖解")
    print("  \(arrowsOK ? "✓" : "✗") arrows and the decorated label's text survive")
    if !arrowsOK { failures += 1 }

    // The reader's switch: off means the book keeps its emoji, all of them.
    let keepURL = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("reepub-emoji-keep-selftest.epub")
    let keepReport = try EpubBuilder.build(pages: [page],
                                           metadata: EpubMetadata(title: "Emoji 測試", author: "", language: "zh-Hant"),
                                           outputURL: keepURL,
                                           options: EpubOptions(removePictographs: false))
    let kept = unzipRead(keepURL, "OEBPS/chapters/ch01.xhtml")
    let keptOK = keepReport.pictographsRemoved == 0 && kept.contains("🧠") && kept.contains("🚀")
    print("  \(keptOK ? "✓" : "✗") with the switch off the book keeps its emoji")
    if !keptOK { failures += 1 }

    // Package conformance: the nav document exists and is declared, and the
    // OPF and NCX agree on one valid UUID (they used to mint their own).
    let opf = unzipRead(url, "OEBPS/content.opf")
    let nav = unzipRead(url, "OEBPS/nav.xhtml")
    let navOK = opf.contains("properties=\"nav\"") && nav.contains("epub:type=\"toc\"")
    print("  \(navOK ? "✓" : "✗") the EPUB 3 navigation document exists and is declared")
    if !navOK { failures += 1 }

    let uuidPattern = "urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    let opfUUID = opf.range(of: uuidPattern, options: .regularExpression).map { String(opf[$0]) }
    let ncx = unzipRead(url, "OEBPS/toc.ncx")
    let ncxUUID = ncx.range(of: uuidPattern, options: .regularExpression).map { String(ncx[$0]) }
    let uuidOK = opfUUID != nil && opfUUID == ncxUUID
    print("  \(uuidOK ? "✓" : "✗") OPF and NCX carry one valid UUID (\(opfUUID ?? "none found"))")
    if !uuidOK { failures += 1 }

    try? FileManager.default.removeItem(at: url)
    try? FileManager.default.removeItem(at: keepURL)
} catch {
    print("  ✗ emoji/package test build failed: \(error.localizedDescription)")
    failures += 1
}

if failures == 0 {
    print("\n[SUCCESS] OCR + EPUB self-test passed.")
    exit(0)
} else {
    print("\n[FAILURE] \(failures) issue(s).")
    exit(1)
}
