# epub-text

**node** · 📋 planned — not yet moved · internal

XML and text plumbing: escaping, serialisation, entity decoding, pictograph stripping. Seven modules import it and every one of them is alive.

## Dependency budget

none — anything beyond the standard library is a change to `packages/manifest.json`, not a change to `package.json`


## Where the code is right now

- `src/epub-text.js`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
