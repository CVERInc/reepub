# cli

**node** · 📋 planned — not yet moved · public

Thin surfaces over the cores: local web UI, the web→EPUB entry point, the image optimizer.

## Dependency budget

none — anything beyond the standard library is a change to `packages/manifest.json`, not a change to `package.json`


## Where the code is right now

- `src/server.js`
- `scripts/build-from-web.js`
- `scripts/optimize.js`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
