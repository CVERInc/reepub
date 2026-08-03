// swift-tools-version: 5.9
import PackageDescription

// epub-kit — recognised pages in, a valid EPUB 3 out.
//
// This is the assembly core, and it is Swift because of where it has to run:
// the app must build a book offline and self-sufficiently, and Vision OCR
// cannot leave Swift, so an assembler that lives anywhere else has to exist
// twice. It did. Between 2026-06-14 and 2026-08-02 the same package document,
// navigation document, NCX and chapter XHTML were written once here and once in
// Node, with a checker comparing the six constants they happened to share and
// nothing watching the rest.
//
// Its dependency on scan-ocr is the honest layering rather than convenience: it
// consumes recognised pages and has no opinion about how they were recognised.
let package = Package(
    name: "epub-kit",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "EpubKit", targets: ["EpubKit"]),
        .executable(name: "epub-kit", targets: ["EpubKitCLI"]),
    ],
    dependencies: [
        .package(path: "../scan-ocr"),
    ],
    targets: [
        .target(name: "EpubKit", dependencies: [
            .product(name: "ScanOCR", package: "scan-ocr"),
        ]),
        .executableTarget(name: "EpubKitCLI", dependencies: ["EpubKit"]),
    ]
)
