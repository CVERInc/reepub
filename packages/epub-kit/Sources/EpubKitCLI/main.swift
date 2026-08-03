import Foundation
import AppKit
import ScanOCR
import EpubKit

// epub-kit — the command line around EpubKit.
//
// It exists so that the Node side can stop having an assembler of its own. The
// two implementations were never a decision: the app needed to build a book
// with no Node present, so assembly was written again in Swift, and from then
// on every rule about escaping, chapter splitting or package documents had two
// homes and one checker watching six constants.
//
// Reads what scan-ocr writes. Nothing here parses a PDF or recognises anything:
// pages arrive as JSON, the images they refer to are read off disk, and a book
// comes out the other side.

struct StandardErrorStream: TextOutputStream {
    func write(_ string: String) {
        if let data = string.data(using: .utf8) { FileHandle.standardError.write(data) }
    }
}
var standardError = StandardErrorStream()

func die(_ message: String) -> Never {
    print("epub-kit: \(message)", to: &standardError)
    print("""

    Usage: epub-kit <pages.json> <out.epub> --title <text> [options]

      <pages.json>        scan-ocr output; "-" reads stdin
      <out.epub>          where to write the book                    (required)
      --title <text>      book title                                 (required)
      --author <name>     dc:creator; omitted when absent
      --images <dir>      where scan-ocr wrote cover.jpeg and its plates.
                          Without it the book is built with no cover and no
                          illustration pages, which is a smaller book, not a
                          broken one.
      --keep-emoji        leave pictographs in the text. They cost a book its
                          cover AND its table of contents on a Kindle, so they
                          are removed by default; this is for a reader who
                          never sends the book to one.
    """, to: &standardError)
    exit(1)
}

// ── the wire scan-ocr writes ─────────────────────────────────────────────────

struct WireLine: Decodable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct WirePage: Decodable {
    let pageIndex: Int
    let lines: [WireLine]
    let type: String
    let imagePath: String?
}

func loadImage(_ url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

// ── arguments ────────────────────────────────────────────────────────────────

var positional: [String] = []
var title: String?
var author = ""
var imagesDir: String?
var keepEmoji = false

var args = Array(CommandLine.arguments.dropFirst())
while let arg = args.first {
    args.removeFirst()
    func value(_ flag: String) -> String {
        guard let v = args.first, !v.hasPrefix("--") else { die("\(flag) needs a value") }
        args.removeFirst()
        return v
    }
    switch arg {
    case "--title":  title = value("--title")
    case "--author": author = value("--author")
    case "--images": imagesDir = value("--images")
    case "--keep-emoji": keepEmoji = true
    default:
        if arg.hasPrefix("--") { die("unknown option \(arg)") }
        positional.append(arg)
    }
}

guard positional.count == 2 else { die("expected <pages.json> and <out.epub>") }
guard let bookTitle = title, !bookTitle.isEmpty else { die("--title is required") }

let (source, outputPath) = (positional[0], positional[1])

// ── read the pages ───────────────────────────────────────────────────────────

let jsonData: Data
if source == "-" {
    jsonData = FileHandle.standardInput.readDataToEndOfFile()
} else {
    guard let data = FileManager.default.contents(atPath: source) else {
        die("cannot read \(source)")
    }
    jsonData = data
}

let wire: [WirePage]
do {
    wire = try JSONDecoder().decode([WirePage].self, from: jsonData)
} catch {
    die("\(source) is not scan-ocr output: \(error.localizedDescription)")
}

// The bitmaps live on disk beside the cover, which is the only directory
// scan-ocr was told about. A page's own imagePath is relative to the book, so
// only its filename is used to find the file that produced it.
let images = imagesDir.map { URL(fileURLWithPath: $0) }
let pages: [OCRPage] = wire.map { page in
    var image: CGImage?
    if let images {
        if page.pageIndex == 0 {
            image = loadImage(images.appendingPathComponent("cover.jpeg"))
        } else if let rel = page.imagePath {
            image = loadImage(images.appendingPathComponent((rel as NSString).lastPathComponent))
        }
    }
    let lines = page.lines.map {
        OCRLine(text: $0.text, x: $0.x, y: $0.y, width: $0.width, height: $0.height)
    }
    return OCRPage(pageIndex: page.pageIndex, lines: lines, type: page.type, image: image)
}

print("Building \(pages.count) page(s) → \(outputPath)", to: &standardError)

do {
    let report = try EpubBuilder.build(
        pages: pages,
        metadata: EpubMetadata(title: bookTitle, author: author),
        outputURL: URL(fileURLWithPath: outputPath),
        options: EpubOptions(removePictographs: !keepEmoji),
        progress: { stage in print("  \(stage)", to: &standardError) })

    // Repair is never silent: anything taken out of someone's book is named.
    if report.pictographsRemoved > 0 {
        print("  removed \(report.pictographsRemoved) pictograph(s) — a Kindle hides the cover and contents of a book that keeps them",
              to: &standardError)
    }
    print("✓ \(outputPath)", to: &standardError)
} catch {
    print("epub-kit: \(error.localizedDescription)", to: &standardError)
    exit(1)
}
