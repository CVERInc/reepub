# epub-kit

**swift** · 📋 planned — not yet moved · internal

The assembly core: package document, navigation document, NCX, chapter XHTML, cover HTML. The one implementation, per decision A.

## Dependency budget

none — anything beyond the standard library is a change to `packages/manifest.json`, not a change to `package.json`


## Where the code is right now

- `packages/epub-kit/Sources/EpubKit/EpubBuilder.swift`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
