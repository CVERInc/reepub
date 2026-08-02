# epub-binder

**node** · 🔀 transitional — exists to be replaced · internal

Emits package documents from Node for heal / merge / web-ingest. Transitional by construction: it is the second assembler, and the boundary gate lists it as a known one until those callers drive epub-kit instead.

## Dependency budget

none — anything beyond the standard library is a change to `packages/manifest.json`, not a change to `package.json`

## Target

epub-kit — Node tools should call the Swift binary rather than emit their own <package>

## Where the code is right now

- `src/binder.js`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
