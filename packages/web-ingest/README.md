# web-ingest

**node** · 📋 planned — not yet moved · internal

A web page reduced to structure: strip layout, translate classes, dehydrate images. The base a web→md exporter would sit on.

## Dependency budget

`cheerio`, `sharp`


## Where the code is right now

- `src/sanitizer.js`
- `src/dehydrator.js`
- `src/web-to-epub.js`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
