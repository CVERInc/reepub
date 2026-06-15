import Foundation
import AppKit
import PDFKit
import ReepubCore

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

let pages = try OCREngine.recognize(pdfURL: tmp) { current, total in
    FileHandle.standardError.write("  OCR page \(current)/\(total)\n".data(using: .utf8)!)
}

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
                          metadata: EpubMetadata(title: "Reepub 自我測試", author: "CVER"),
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
                          metadata: EpubMetadata(title: hostileTitle, author: hostileAuthor),
                          outputURL: url)
    print("  ✓ hostile title/author built without XML errors")
    try? FileManager.default.removeItem(at: url)
} catch {
    print("  ✗ hostile title/author build failed: \(error.localizedDescription)")
    failures += 1
}

if failures == 0 {
    print("\n[SUCCESS] OCR + EPUB self-test passed.")
    exit(0)
} else {
    print("\n[FAILURE] \(failures) issue(s).")
    exit(1)
}
