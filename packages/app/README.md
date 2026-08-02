# app

**swift** · 📋 planned — not yet moved · product

The product. SwiftUI, offline, consumes scan-ocr + epub-kit.

## Dependency budget

none — anything beyond the standard library is a change to `packages/manifest.json`, not a change to `package.json`


## Where the code is right now

- `macos/Sources/ReepubApp/ReepubApp.swift`
- `macos/Sources/ReepubApp/ContentView.swift`
- `macos/Sources/ReepubApp/Localization.swift`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
