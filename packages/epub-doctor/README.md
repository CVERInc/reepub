# epub-doctor

**node** · 📋 planned — not yet moved · public

Operates on finished EPUBs: validate, heal, merge. Never touches OCR, never rasterises a cover — which is what keeps its dependency budget to one library.

## Dependency budget

`cheerio`


## Where the code is right now

- `src/validator.js`
- `src/heal.js`
- `src/merge.js`
- `src/contents-page.js`
- `src/emoji-glyphs.js`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
