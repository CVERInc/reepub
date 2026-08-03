# Does WKWebView lay out the cover like Chromium?

**Measured 2026-08-04: yes, to within a pixel.** The layout risk in migrating the
cover rasteriser off Chromium did not materialize. What remains is a port of the
measurement loop, not a redesign.

## Why the question matters

Playwright and a bundled Chromium are in reepub's dependency list for exactly one
reason: the typeset cover is rendered in a browser. `epub-raster` is the only
package that pulls them, and a repair tool has to work without it
(`scripts/check-optional-boundary.mjs` asserts that). If WKWebView — already on
every Mac, already linked by the app — produces the same cover, that dependency
can go.

The specific fear was type fitting. The cover is not laid out at a fixed size:
each line of a display title is scaled to fill the measure, and the scale is
found by measuring text *in the browser*. Two engines that measure text
differently produce different scales, and then a cover that was tuned to be
legible at thumbnail size stops being.

## Method

Both engines rendered byte-identical HTML from `buildCoverHtml`, at 1600×2260,
with no other difference.

```bash
# WKWebView
swift run --package-path packages/cover-probe CoverProbe cover.html wk.png 1600 2260

# Chromium, via the path the tool actually uses
node -e "…chromium.launch(); page.setContent(html); page.screenshot(…)"
```

Compared on: differing pixels (greyscale, threshold 16/255), total ink coverage,
per-line ink extent, and the ink bounding box.

## Results

| specimen | differing pixels | ink coverage | line widths |
|---|---|---|---|
| Latin, ltr, two-line display title | **0.48%** | 2.74% vs 2.74% | 1015 vs 1016 px, 988 vs 988, 970 vs 970 |
| CJK, rtl, vertical | **0.27%** | 0.68% vs 0.68% | ink bounding box **identical**: `566,837 → 1006,2121` |

The CJK case is the one that was expected to break — `line-break: strict`,
vertical writing mode, no word gaps to balance on — and its ink bounding box
matches to the pixel in both dimensions.

Where the remaining difference lives: the differing pixels cluster in bands one
to fifteen rows tall at the cap-height and baseline edges of each text line, with
0.0–0.4% difference through the middle of the same line. That is glyph
rasterisation — hinting and antialiasing — not layout.

## Two ways this measurement lied before it was right

Recorded because both produced confident, wrong answers, and both are easy to
repeat.

**WKWebView snapshots at the display's backing scale.** A 1600×2260 request
returns 3200×4520 on a Retina Mac. Reading that buffer with 1600-wide indexing
reports zero ink in every band and a −100% difference on every line — a result
that looks like a catastrophic rendering failure and is entirely an artifact of
the ruler. *Validate the ruler before blaming the worker.*

**Blurring made the difference worse, which seemed to disprove antialiasing.**
It was run on the mismatched buffers above. Once both images were normalized to
the same dimensions the bands resolved into glyph edges, which is what the
blur test was supposed to show in the first place.

## What is left to do

This measured **rendering**, not the migration. The cover generator also
*measures* in the browser — it sets content, reads back text metrics, and
re-fits until the title fills the measure. Porting that loop to WKWebView means
`evaluateJavaScript` round-trips and an async fitting loop in Swift. That is the
work; this document is the evidence that it is worth doing.

Also unmeasured: a title long enough to be merged back to fewer lines, and a
book with a translator credit. Both exercise the same fitting loop, so neither
is expected to differ — but expected is not measured.
