// swift-tools-version: 5.9
import PackageDescription

// reepub's native macOS app, now an SPM package so it can depend on Signet
// (the shared CVER design system). Pinned to swift-tools 5.9 / macOS 13.
//
// What is left here is the app. Recognition moved to packages/scan-ocr on
// 2026-08-02 and assembly to packages/epub-kit on 2026-08-03, both for the same
// reason: neither is about the app, and living inside the app is what let a
// second copy of each grow somewhere else. The framework-free self-test stays,
// driving both cores through a real OCR → EPUB round-trip.
let package = Package(
    name: "reepub",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "ReepubApp", targets: ["ReepubApp"]),
        .executable(name: "ReepubSelfTest", targets: ["ReepubSelfTest"]),
    ],
    dependencies: [
        // Signet — CVER's shared design system. Pinned to main / latest.
        .package(url: "https://github.com/CVERInc/signet", branch: "main"),
        // The recognition engine, which knows nothing about EPUB and is a
        // package of its own for exactly that reason. The app and the
        // command-line binary read the same one; before this they each had a
        // copy, and one of them said so in a comment nothing verified.
        .package(path: "../packages/scan-ocr"),
        // The assembly core. It left this package on 2026-08-03 for the same
        // reason the OCR engine did: it is not about the app, and living inside
        // the app is what let a second copy grow elsewhere.
        .package(path: "../packages/epub-kit"),
    ],
    targets: [
        // SwiftUI app over the two cores, reef-themed via Signet. There is no
        // logic target left here: recognition is scan-ocr's and assembly is
        // epub-kit's, which leaves this package holding only the app.
        .executableTarget(name: "ReepubApp", dependencies: [
            .product(name: "ScanOCR", package: "scan-ocr"),
            .product(name: "EpubKit", package: "epub-kit"),
            .product(name: "Signet", package: "signet"),
        ]),
        // Framework-free self-test (real OCR → EPUB round-trip).
        .executableTarget(name: "ReepubSelfTest", dependencies: [
            .product(name: "ScanOCR", package: "scan-ocr"),
            .product(name: "EpubKit", package: "epub-kit"),
        ]),
    ]
)
