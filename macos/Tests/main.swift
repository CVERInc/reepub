import Foundation
import AppKit
import PDFKit

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

    let text = "Reepub 測試文件\n第一章 開始\nHello World 你好世界\n這是一段用來驗證 OCR 的中文測試文字。"
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

if failures == 0 {
    print("\n[SUCCESS] OCR self-test passed.")
    exit(0)
} else {
    print("\n[FAILURE] \(failures) expected string(s) not recognized.")
    exit(1)
}
