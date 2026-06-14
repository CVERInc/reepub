import Foundation
import Vision
import PDFKit
import AppKit

/// One recognized line of text with its normalized bounding box (y is bottom-up, 0...1).
public struct OCRLine {
    public let text: String
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double
}

/// One OCR'd PDF page. `type` is "text" or "image" (low-text pages kept as image plates).
public struct OCRPage {
    public let pageIndex: Int
    public let lines: [OCRLine]
    public let type: String
    public var image: CGImage?
}

/// OCR failures. The associated value carries the offending name; the
/// human-readable, localized message is produced at the UI layer (ContentView)
/// so this type stays free of any presentation/locale concerns.
public enum OCRError: LocalizedError {
    case cannotOpenPDF(String)
    public var errorDescription: String? {
        switch self {
        case .cannotOpenPDF(let name): return "Cannot open PDF: \(name)"
        }
    }
}

/// Native Vision + PDFKit OCR. Mirrors the heuristics in src/main.swift so the
/// app and the Node CLI stay in sync.
public enum OCREngine {
    /// Render a PDF page to a bitmap at `scale`× on a white background.
    static func renderImage(from page: PDFPage, scale: CGFloat = 2.0) -> CGImage? {
        let bounds = page.bounds(for: .cropBox)
        let width = Int(bounds.size.width * scale)
        let height = Int(bounds.size.height * scale)
        guard width > 0, height > 0,
              let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: width, height: height,
                                  bitsPerComponent: 8, bytesPerRow: 0, space: colorSpace,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }

        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.scaleBy(x: scale, y: scale)
        ctx.saveGState()
        page.draw(with: .cropBox, to: ctx)
        ctx.restoreGState()
        return ctx.makeImage()
    }

    /// Recognize zh-Hant + en text in an image.
    static func recognizeLines(in image: CGImage) -> [OCRLine] {
        var lines: [OCRLine] = []
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        let request = VNRecognizeTextRequest { req, _ in
            guard let observations = req.results as? [VNRecognizedTextObservation] else { return }
            for obs in observations {
                guard let top = obs.topCandidates(1).first else { continue }
                let box = obs.boundingBox
                lines.append(OCRLine(text: top.string,
                                     x: Double(box.origin.x), y: Double(box.origin.y),
                                     width: Double(box.size.width), height: Double(box.size.height)))
            }
        }
        request.recognitionLanguages = ["zh-Hant", "en-US"]
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        try? handler.perform([request])
        return lines
    }

    /// OCR every page of a PDF. `progress` is invoked with (current, total) on a
    /// background queue.
    public static func recognize(pdfURL: URL, progress: ((Int, Int) -> Void)? = nil) throws -> [OCRPage] {
        guard let doc = PDFDocument(url: pdfURL) else {
            throw OCRError.cannotOpenPDF(pdfURL.lastPathComponent)
        }

        let total = doc.pageCount
        var pages: [OCRPage] = []

        for i in 0..<total {
            autoreleasepool {
                progress?(i + 1, total)
                guard let page = doc.page(at: i),
                      let image = renderImage(from: page) else { return }

                let raw = recognizeLines(in: image)
                // top-to-bottom, left-to-right
                let sorted = raw.sorted { a, b in
                    if abs(a.y - b.y) < 0.015 { return a.x < b.x }
                    return a.y > b.y
                }

                let totalChars = sorted.reduce(0) { $0 + $1.text.count }
                let type = totalChars < 120 ? "image" : "text"
                pages.append(OCRPage(pageIndex: i, lines: sorted, type: type, image: image))
            }
        }
        return pages
    }
}
