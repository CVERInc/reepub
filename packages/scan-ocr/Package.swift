// swift-tools-version: 5.9
import PackageDescription

// scan-ocr — a PDF page, recognised. Apple Vision + PDFKit, on this machine,
// with no network path to remove.
//
// It is its own package because it knows nothing about EPUB, and everything
// that used it had to build one first. The engine lived twice before this:
// src/main.swift for the CLI and macos/.../OCREngine.swift for the app, and
// the second one carried a comment saying it "mirrors the heuristics" of the
// first. Nothing checked that claim. The render scale, the 0.015 same-line
// tolerance and the 120-character text/image threshold each existed in two
// places, free to drift.
//
// The split here is by concern, not by caller: ScanOCR is the recognition, and
// the executable is the command line around it — argument parsing, the JSON on
// stdout, and the images written to disk.
let package = Package(
    name: "scan-ocr",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ScanOCR", targets: ["ScanOCR"]),
        .executable(name: "scan-ocr", targets: ["ScanOCRCLI"]),
    ],
    targets: [
        .target(name: "ScanOCR"),
        .executableTarget(name: "ScanOCRCLI", dependencies: ["ScanOCR"]),
    ]
)
