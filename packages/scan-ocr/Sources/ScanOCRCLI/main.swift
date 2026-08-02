import Foundation
import PDFKit
import Cocoa
import ScanOCR

// scan-ocr — the command line around ScanOCR.
//
// Everything here is about the edges: arguments in, JSON on stdout, images on
// disk, diagnostics on stderr. The recognition itself is the library's, and
// this file deliberately keeps no copy of it. It used to: the render scale, the
// same-line tolerance and the text/image threshold were written out here and
// again in the app, and nothing would have said a word if one had changed.

struct StandardErrorStream: TextOutputStream {
    func write(_ string: String) {
        if let data = string.data(using: .utf8) {
            FileHandle.standardError.write(data)
        }
    }
}
var standardError = StandardErrorStream()

// The wire format, which belongs to the command line rather than to the engine:
// `imagePath` is a path this process wrote, and means nothing to a caller
// holding bitmaps in memory. src/builder.js reads exactly these names.
struct WireLine: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WirePage: Codable {
    let pageIndex: Int
    let lines: [WireLine]
    let type: String
    let imagePath: String?
}

func jpegData(from image: CGImage, compression: CGFloat = 0.8) -> Data? {
    NSBitmapImageRep(cgImage: image)
        .representation(using: .jpeg, properties: [.compressionFactor: compression])
}

/// Page one, written as the book's cover. Kept out of the recognition pass so a
/// cover is still produced for a PDF whose first page recognises as nothing.
func saveFirstPageAsCover(document: PDFDocument, path: String) {
    guard document.pageCount > 0, let page = document.page(at: 0) else { return }
    guard let image = OCREngine.renderImage(from: page) else { return }
    guard let data = jpegData(from: image) else { return }
    do {
        try data.write(to: URL(fileURLWithPath: path))
        print("Saved cover image to: \(path)", to: &standardError)
    } catch {
        print("Error saving cover image: \(error)", to: &standardError)
    }
}

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

    let coverPath: String? = args.count >= 3 ? args[2] : nil
    if let coverPath {
        saveFirstPageAsCover(document: document, path: coverPath)
    }

    print("Opening PDF: \(pdfPath)", to: &standardError)
    print("Total pages: \(document.pageCount)", to: &standardError)

    // Where a plate lands: beside the cover, which is the only directory this
    // process has been told about.
    let imagesDir = coverPath.map { URL(fileURLWithPath: $0).deletingLastPathComponent() }
    var plates: [Int: String] = [:]

    let pages: [OCRPage]
    do {
        pages = try OCREngine.recognize(
            pdfURL: url,
            keepImages: false,
            progress: { current, total in
                print("Performing OCR on page \(current)/\(total)...", to: &standardError)
            },
            onPage: { page, image in
                // Page one is already the cover; a later page with almost no
                // text is an illustration worth keeping as a picture.
                guard page.type == "image", page.pageIndex > 0,
                      let imagesDir, let data = jpegData(from: image) else { return }
                let name = "page_\(page.pageIndex + 1).jpeg"
                let target = imagesDir.appendingPathComponent(name)
                do {
                    try data.write(to: target)
                    plates[page.pageIndex] = "images/\(name)"
                    print("Saved image page to: \(target.path)", to: &standardError)
                } catch {
                    print("Error saving image page: \(error)", to: &standardError)
                }
            })
    } catch {
        print("Error: \(error.localizedDescription)", to: &standardError)
        exit(1)
    }

    let wire = pages.map { page in
        WirePage(pageIndex: page.pageIndex,
                 lines: page.lines.map {
                     WireLine(text: $0.text, x: $0.x, y: $0.y, width: $0.width, height: $0.height)
                 },
                 type: page.type,
                 imagePath: plates[page.pageIndex])
    }

    let encoder = JSONEncoder()
    encoder.outputFormatting = .prettyPrinted
    do {
        let jsonData = try encoder.encode(wire)
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
