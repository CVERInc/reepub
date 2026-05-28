import Foundation
import Vision
import PDFKit
import Cocoa

// Standard error output stream
struct StandardErrorStream: TextOutputStream {
    func write(_ string: String) {
        if let data = string.data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
    }
}
var standardError = StandardErrorStream()

// Data models for serialization
struct OCRLine: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct OCRPage: Codable {
    let pageIndex: Int
    let lines: [OCRLine]
    let type: String
    let imagePath: String?
}

// Convert PDFPage to CGImage
func cgImage(from page: PDFPage, scale: CGFloat = 2.0) -> CGImage? {
    let pageBounds = page.bounds(for: .cropBox)
    let width = Int(pageBounds.size.width * scale)
    let height = Int(pageBounds.size.height * scale)
    
    guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    
    // Draw white background
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    
    // Scale the context
    context.scaleBy(x: scale, y: scale)
    
    // Draw PDF page
    context.saveGState()
    page.draw(with: .cropBox, to: context)
    context.restoreGState()
    
    return context.makeImage()
}

// Perform OCR on CGImage
func performOCR(image: CGImage) -> [OCRLine] {
    var lines: [OCRLine] = []
    let requestHandler = VNImageRequestHandler(cgImage: image, options: [:])
    
    let request = VNRecognizeTextRequest { request, error in
        guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
        for observation in observations {
            guard let topCandidate = observation.topCandidates(1).first else { continue }
            let box = observation.boundingBox // normalized coordinates, y is bottom-up
            lines.append(OCRLine(
                text: topCandidate.string,
                x: Double(box.origin.x),
                y: Double(box.origin.y),
                width: Double(box.size.width),
                height: Double(box.size.height)
            ))
        }
    }
    
    // Request Traditional Chinese and English
    request.recognitionLanguages = ["zh-Hant", "en-US"]
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    
    do {
        try requestHandler.perform([request])
    } catch {
        print("OCR Error on page: \(error)", to: &standardError)
    }
    
    return lines
}

// Save first page as cover JPEG
func saveFirstPageAsCover(document: PDFDocument, path: String) {
    guard document.pageCount > 0, let page = document.page(at: 0) else { return }
    guard let image = cgImage(from: page, scale: 2.0) else { return }
    let bitmapRep = NSBitmapImageRep(cgImage: image)
    guard let data = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) else { return }
    do {
        try data.write(to: URL(fileURLWithPath: path))
        print("Saved cover image to: \(path)", to: &standardError)
    } catch {
        print("Error saving cover image: \(error)", to: &standardError)
    }
}

// CLI entry point
func main() {
    let args = CommandLine.arguments
    if args.count < 2 {
        print("Usage: scan-ocr <input-pdf-file> [cover-output-path]", to: &standardError)
        exit(1)
    }
    
    let pdfPath = args[1]
    let url = URL(fileURLWithPath: pdfPath)
    
    guard let document = PDFDocument(url: url) else {
        print("Error: Cannot open PDF file at \(pdfPath)", to: &standardError)
        exit(1)
    }
    
    if args.count >= 3 {
        let coverPath = args[2]
        saveFirstPageAsCover(document: document, path: coverPath)
    }
    
    print("Opening PDF: \(pdfPath)", to: &standardError)
    print("Total pages: \(document.pageCount)", to: &standardError)
    
    var ocrPages: [OCRPage] = []
    
    for i in 0..<document.pageCount {
        autoreleasepool {
            print("Performing OCR on page \(i + 1)/\(document.pageCount)...", to: &standardError)
            guard let page = document.page(at: i) else {
                print("Error: Could not retrieve page \(i + 1)", to: &standardError)
                return
            }
            
            guard let image = cgImage(from: page, scale: 2.0) else {
                print("Error: Could not render page \(i + 1) to image", to: &standardError)
                return
            }
            
            let lines = performOCR(image: image)
            
            // Sort lines from top-to-bottom, left-to-right
            let sortedLines = lines.sorted { (l1, l2) -> Bool in
                if abs(l1.y - l2.y) < 0.015 { // approximately same line
                    return l1.x < l2.x
                }
                return l1.y > l2.y // higher y is top-most
            }
            
            let totalChars = sortedLines.reduce(0) { $0 + $1.text.count }
            var pageType = "text"
            var savedImagePath: String? = nil
            
            if totalChars < 120 {
                pageType = "image"
                if i > 0 && args.count >= 3 {
                    let coverPath = args[2]
                    let coverURL = URL(fileURLWithPath: coverPath)
                    let imagesDirURL = coverURL.deletingLastPathComponent()
                    let pageImageName = "page_\(i + 1).jpeg"
                    let pageImageURL = imagesDirURL.appendingPathComponent(pageImageName)
                    
                    let bitmapRep = NSBitmapImageRep(cgImage: image)
                    if let data = bitmapRep.representation(using: .jpeg, properties: [.compressionFactor: 0.8]) {
                        do {
                            try data.write(to: pageImageURL)
                            savedImagePath = "images/\(pageImageName)"
                            print("Saved image page to: \(pageImageURL.path)", to: &standardError)
                        } catch {
                            print("Error saving image page: \(error)", to: &standardError)
                        }
                    }
                }
            }
            
            ocrPages.append(OCRPage(pageIndex: i, lines: sortedLines, type: pageType, imagePath: savedImagePath))
        }
    }
    
    // Output JSON to stdout
    let encoder = JSONEncoder()
    encoder.outputFormatting = .prettyPrinted
    do {
        let jsonData = try encoder.encode(ocrPages)
        if let jsonString = String(data: jsonData, encoding: .utf8) {
            print(jsonString)
        }
    } catch {
        print("JSON encoding error: \(error)", to: &standardError)
        exit(1)
    }
    
    print("OCR extraction completed successfully.", to: &standardError)
}

main()
