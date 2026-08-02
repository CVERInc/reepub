# ocr-builder-node

**node** · ❄️ freeze-pending · none

The Node path from OCR output to EPUB, and the paragraph heuristics only it uses. This is the ONLY code genuinely duplicated by EpubBuilder.swift.

## Dependency budget

none — anything beyond the standard library is a change to `packages/manifest.json`, not a change to `package.json`

## Freeze

flips to "frozen" when the CLI builds through epub-kit. Kept, not strangled — but kept as a FILE, never as a documented way to use reepub.

## Where the code is right now

- `src/builder.js`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
