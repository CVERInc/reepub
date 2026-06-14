// swift-tools-version: 5.9
import PackageDescription

// reepub's native macOS app, now an SPM package so it can depend on Signet
// (the shared CVER design system). Pinned to swift-tools 5.9 / macOS 13.
//
// Layout mirrors the family convention (cf. snapsift): a pure logic library
// (ReepubCore: OCR + EPUB assembly, locale-free), the SwiftUI app on top
// (ReepubApp), and a framework-free self-test executable that drives Core
// through a real OCR → EPUB round-trip.
let package = Package(
    name: "reepub",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "ReepubCore", targets: ["ReepubCore"]),
        .executable(name: "ReepubApp", targets: ["ReepubApp"]),
        .executable(name: "ReepubSelfTest", targets: ["ReepubSelfTest"]),
    ],
    dependencies: [
        // Signet — CVER's shared design system. Pinned to main / latest.
        .package(url: "https://github.com/CVERInc/signet", branch: "main"),
    ],
    targets: [
        // Pure logic: Vision OCR + EPUB3 assembly. No UI, no locale.
        .target(name: "ReepubCore"),
        // SwiftUI app over Core, reef-themed via Signet.
        .executableTarget(name: "ReepubApp", dependencies: [
            "ReepubCore",
            .product(name: "Signet", package: "signet"),
        ]),
        // Framework-free self-test (real OCR → EPUB round-trip).
        .executableTarget(name: "ReepubSelfTest", dependencies: ["ReepubCore"]),
    ]
)
