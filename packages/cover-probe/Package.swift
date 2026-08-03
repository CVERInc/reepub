// swift-tools-version:5.9
import PackageDescription

let package = Package(
  name: "cover-probe",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "CoverProbe", path: "Sources/CoverProbe")
  ]
)
