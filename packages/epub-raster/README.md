# epub-raster

**node** · planned · internal

Turns the typeset cover into pixels, and redraws pictographs as engravings. Chromium and sharp live here and nowhere else — this is the package a repair tool must be able to do without.

## Dependency budget

`playwright`, `sharp`

These are the heaviest things in the repository, which is the whole reason this
package has its own name: `epub-doctor` validates, heals and merges books with
one library, and it can only make that claim if the browser lives somewhere it
is allowed not to install. A lazy `require` would not have been enough — the
cost is charged when a package is installed, not when a line runs.

Callers reach it through `optional()` (see `src/optional.js`), the call shape
`scripts/check-packages.mjs` recognises as an edge that may be absent. A plain
`require` of the same module is charged to the budget, as it should be.

## Target

one of two rasterisers over one typesetter; the app's is WKWebView

## Where the code is right now

- `src/cover-generator.js`
- `src/emoji-glyphs.js`
