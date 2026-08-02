# epub-cover

**node** · 📋 planned — not yet moved · internal

Typesets a cover and rasterises it through a browser. Separated from epub-doctor so that package can be installed without downloading Chromium — a lazy require would not have helped, because the dependency is charged at install time, not at load time.

## Dependency budget

`playwright`, `sharp`

## Target

the typesetting half moves to epub-kit (Swift) and emits HTML; this package keeps only the Node rasteriser, with WKWebView as the app's

## Where the code is right now

- `src/cover-generator.js`
- `src/title-setting.js`

The ledger in [`../manifest.json`](../manifest.json) is the source of truth, and
`scripts/check-packages.mjs` fails the build if this list and the tree disagree.
Nothing has moved yet — this directory is the shape, not the contents.
