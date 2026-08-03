# epub-cover

**node** · planned · internal

The cover as text, with no browser in it: which layout an edition gets, the XHTML page that shows the finished image, and where an English title breaks. merge needs the cover PAGE for every book that has one — including a cover it merely carried across — so this half must be reachable without installing Chromium.

## Dependency budget

none — anything beyond the standard library is a change to
`packages/manifest.json`, not to `package.json`.

Nothing here draws. Rasterising is `epub-raster`'s job, and that split is what
lets a repair tool ask for the cover *page* without asking for a browser.

## Target

moves to epub-kit (Swift), which emits the same HTML for both rasterisers

## Where the code is right now

- `src/cover-page.js`
- `src/title-setting.js`
