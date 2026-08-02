# scan-ocr

**swift** · 📋 planned — not yet moved · public

PDF → one JSON line per recognised text line, with bounding boxes. Apple Vision. No EPUB knowledge whatsoever.

## Dependency budget

none — anything beyond the standard library is a change to `packages/manifest.json`, not a change to `package.json`


## Where the code is right now

- `src/main.swift`
- `macos/Sources/ReepubCore/OCREngine.swift`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
