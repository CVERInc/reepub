# The numbers, and where they came from

Every threshold in reepub that a reader could reasonably ask "why that value?"
about, with the answer. Nothing here is a specification anybody publishes; each
one was measured, or arrived at by watching a specific thing go wrong.

This file exists because most of these answers lived only in Swift comments.
The platform is replaceable — the decision to keep the assembly core in Swift
turns on Vision OCR, and if reepub ever left macOS the OCR would be what stays
behind, not this ledger. Knowledge that only exists next to an implementation
leaves with it.

**These are records, not promises.** Nothing in CI asserts the values below are
right; what CI asserts is that the two implementations agree on the two rules
that are promised (see [PRINCIPLES.md](../PRINCIPLES.md) §6). If a value here is
wrong, the fix is to measure again and change it in both places — not to argue
from this document.

---

## Recognition

Source: `packages/scan-ocr/Sources/ScanOCR/OCREngine.swift`

### `sameLineTolerance = 0.015`

Two recognized lines whose normalized `y` differ by less than this are treated
as one line and re-ordered left to right.

Vision returns observations in reading order per region, not per page. A page
with two columns, a running head, or a marginal note produces boxes whose
vertical centres are equal to within a pixel or two but which arrive out of
order. Without a tolerance the paragraph stitcher sees the second column's
first line as a continuation of the first column's — and 0.015 of page height
is roughly a third of a body line at typical scan resolutions, so it is wide
enough to catch a wobbling baseline and narrow enough not to swallow the line
below.

### `textPageMinimumCharacters = 120`

A page that recognizes fewer characters than this is packaged as an image plate
rather than as prose.

The failure it prevents is worse than losing the text: an illustration with a
caption, or a plate with a stamp on it, recognizes as a handful of fragments
scattered across the page, and those fragments get stitched into a paragraph
that reads as noise. A reader can look at a picture; nobody can read garbled
OCR. 120 characters is roughly two lines of prose — below that there is not
enough on the page for the geometry heuristics to have anything to work with
either.

**This constant does more than it says.** It is the classifier that decides
whether a page is *fixed* (the page is the unit, as in a comic or a plate) or
*flow* (the page is an artifact of the paper it was printed on). That
distinction is the one pagetile locked on 2026-07-15; reepub has been computing
it since before it had a name.

### `renderScale = 2.0`

PDF pages are rasterized at twice their crop box before recognition.

Vision reads a 2× bitmap markedly better than a 1× one. Higher costs memory and
time on long books without a corresponding gain — the recognition is limited by
the scan, not by the resampling, once there are enough pixels per glyph.

---

## Paragraph geometry

Source: `packages/epub-kit/Sources/EpubKit/EpubBuilder.swift`, mirrored in
`src/epub-text.js`.

All of these are multiples of `avgHeight` — the mean recognized line height on
that page — rather than absolute distances. That is the point: a threshold in
page-fractions breaks on the next book, because scans differ in resolution,
margin and type size. A threshold in multiples of the type on *this* page
travels.

| Value | Rule | Why |
|---|---|---|
| `y > 0.94` | drop as running head | Above the top 6% of the page is furniture, not text. |
| `y < 0.06` | drop as footer / folio | Same at the foot. Page numbers are the common case, and a folio stitched into the last paragraph is the visible symptom. |
| `gap > avgHeight × 1.8` | paragraph break | Nearly two line-heights of white is a deliberate break, not leading. |
| `gap > avgHeight × 0.95` **and** previous line ends in break punctuation | paragraph break | A sentence that has ended plus any extra leading at all. The punctuation carries most of the evidence, so the geometric bar drops to roughly one line. |
| `line.x − prev.x > 0.05` | paragraph break | A first-line indent. 5% of page width is larger than any jitter in the box, smaller than any real indent. |
| `height > avgHeight × 1.45` | paragraph break | A change of type size is a change of role — this catches the boundary at a heading, from either side of it. |
| `height > avgHeight × 1.35` **and** one line **and** under 40 graphemes | heading | Bigger than the body, short, and alone. All three are needed: a single large line that runs long is a pull quote or a first line set large. |

### About "40 graphemes"

Graphemes, not characters. Swift's `String.count` counts extended grapheme
clusters; JavaScript's `String#length` counts UTF-16 code units. A
Traditional-Chinese title measured 50 in one language and 25 in the other — a
real divergence found by `scripts/check-sync-markers.mjs`, which is why the JS
side uses `Intl.Segmenter` and never `String#length`.

---

## The cover ground

Source: `src/cover-page.js` (`COVER_GROUND = '#111111'`), instrument in
`scripts/calibrate-cover-ground.mjs`.

A cover is almost never the shape of the screen it lands on, so the reader fills
the difference. On a Kindle lock screen that fill runs down both sides of the
cover — and it is **not pure black**. Measured off a photograph it sits around
ten luminance units above `#000000`, which is enough to draw a visible seam down
a black cover.

Amazon publishes cover dimensions and says nothing about the fill, so there is
no value to look up: it has to be measured off the device. `calibrate-cover-ground.mjs`
builds the instrument — a book whose cover is a ladder of labelled grey bands.
Put it on the reader, open it so it becomes the current book, let the screen
lock, photograph it. The band whose edge disappears into the fill *is* the fill.

One photograph settles it. Anyone whose device disagrees can disagree with
evidence, which is the only reason this is a constant with a script named beside
it rather than a number somebody liked.

---

## Where these are asserted

- `scripts/check-sync-markers.mjs` — records where the Node and Swift paragraph
  geometry differ, and **fails** if the XML escape table or the pictograph range
  differ. Those two are the promised ones.
- `src/test-core-spec.js` — asserts cover ink coverage and contrast survive at
  thumbnail size, which is the outcome `COVER_GROUND` exists to protect.
- `scripts/check-ocr-contract.mjs` — runs the real `scan-ocr` binary and asserts
  the wire format the geometry heuristics consume.
