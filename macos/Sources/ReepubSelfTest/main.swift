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

if failures == 0 {
    print("\n[SUCCESS] OCR + EPUB self-test passed.")
    exit(0)
} else {
    print("\n[FAILURE] \(failures) issue(s).")
    exit(1)
}
