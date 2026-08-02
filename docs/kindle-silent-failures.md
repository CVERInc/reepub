# Silent failures on a Kindle

> **Two bugs, not one.** Both make a Kindle hide the cover *and* the table of
> contents of an entire book. Both produce files that epubcheck passes with
> 0 errors / 0 warnings. Both were found the only way they could be — by
> bisection over ~40 builds side-loaded onto a real device, one book at a time,
> 2026-08-01.

## Why this file exists

Each fix already lives next to its evidence in the code:
[`src/binder.js`](../src/binder.js) (the RTL metadata) and
[`src/epub-text.js`](../src/epub-text.js) (the pictograph rule). Those comments
record what is true and why.

What a comment cannot hold is **what was ruled out** — and that was almost the
entire cost of the investigation. Roughly thirty-five of the forty builds
existed to kill a hypothesis, and every one of those deaths is a question the
next person does not have to re-ask on their own device.

This is the disproof ledger. Read it before theorising about a Kindle that will
not show a cover.

## The two rules

| | Trigger | Symptom | Fixed in | Locked by |
|---|---|---|---|---|
| **1** | `page-progression-direction="rtl"` without `<meta name="primary-writing-mode">` | No cover, no TOC | `src/binder.js` (`KINDLE_RTL_WRITING_MODE`) | `src/test-core-spec.js` |
| **2** | Any pictographic emoji in the text, anywhere in the book | No cover, no TOC | `src/epub-text.js` (`PICTOGRAPH`) | `src/test-web-spec.js` **and** `macos/Sources/ReepubSelfTest/main.swift` |

Rule 2 is asserted on both sides of the language border, separately. That is
deliberate: the two assemblers can drift, and a rule that only one of them
enforces is a rule the other will eventually break. Both suites also assert what
must *survive* — `→`, `•`, and `𡒉` — because a compatibility rule that quietly
widens is worse than the defect it fixes.

Both symptoms are identical from the reader's side, which is exactly why the
first investigation's conclusion did not transfer to the second book and five
more hours went into rediscovering that.

---

## Bug 1 — an RTL book with no `primary-writing-mode`

**Corpus:** five Jin Yong volumes (vertical, right-to-left). **Control:** the
Steve Jobs biography (horizontal, LTR) — which always worked.

### Ruled out

| Build | Hypothesis | Result |
|---|---|---|
| A | cover page as inline-styled `<img>` | cover shows — **writing style is not it** |
| B | cover page exactly as the known-good book wrote it | cover shows |
| C | SVG `viewBox` + `preserveAspectRatio` wrapper | cover shows |
| D | C plus an EPUB 2 `<guide>` element | cover shows |
| E | the failing book renamed, byte-identical | no cover — **but this test was invalid** (below) |
| G | genuinely new book: new title, new `dc:identifier` | no cover — kills the "stale KFX cache" theory |
| J | drop both `rtl` and `page-template.xpgt` | cover shows |
| K | drop `rtl` only | cover shows — **but see "curing by killing"** |
| L, M | keep `rtl`, vary the cover page again | no cover |
| N | `rtl` + `primary-writing-mode: vertical-rl` | no cover |
| **O** | `rtl` + `primary-writing-mode: horizontal-rl` | **cover shows, text still vertical** ✓ |

`page-template.xpgt` was eliminated early: only the Jin Yong books carried it,
and they failed with and without it.

### The value is the counterintuitive one

A vertical Chinese book needs `horizontal-rl`, not `vertical-rl`. The name
describes the *page progression*, not the text flow, and `vertical-rl` — the
value that honestly describes the book — leaves the cover exactly as broken.
Text direction is unaffected either way because that comes from the stylesheet.

A constant whose name argues against its value is the kind that gets "corrected"
by a future reader. That is why the derivation sits in a comment above it rather
than in a commit message.

### Curing by killing

Build K "worked": remove `page-progression-direction="rtl"` and the cover comes
back. It is also useless — the book then opens left-to-right, so a reader turns
pages backwards through a Chinese novel. **A fix that restores the symptom's
absence by removing the feature is not a fix**, and it is dangerously attractive
at hour four of an investigation.

### Free finding

Vertical titles containing Latin letters get each letter stood upright by
`text-orientation: upright`, producing a column of single characters. Harmless
for `鹿鼎記`; it will matter for Japanese titles containing English. Not fixed.

---

## Bug 2 — pictographic emoji anywhere in the text

**Corpus:** *The Book of Elon*. **Controls:** the Jin Yong volumes (now fixed by
rule 1) and the Steve Jobs biography.

This one resisted seven consecutive single-variable tests, and the reason is
worth stating before the table: **every one of them removed something that was
not the cause, from a book that still contained the cause.**

### Ruled out

| Build | Removed / changed | Result |
|---|---|---|
| P | nothing; fresh title and uuid | dead |
| Q, W | added `horizontal-lr` / `horizontal-rl` | dead — **rule 1 does not apply here** |
| R | translator metadata | dead |
| S | in-text images | dead |
| T | `stylesheet.css` | dead |
| U | all but 2 chapters | dead |
| V | R+S+T+U at once (real text, no CSS, no images) | dead |
| X2 | its cover swapped for a known-good cover image | dead |
| Y2 | a known-good book given *its* cover image | alive — **the image is innocent** |
| Z1 | chapter bodies replaced with stubs, CSS kept | dead |
| Z2 | one real chapter only | dead |
| **BB** | stripped to the exact shape of a known-good book: stubs, no CSS, no images | **alive** |
| C3 | first 25 blocks per chapter | alive |
| D1 | first 30 blocks per chapter | dead |
| F1 | complete book, 222 emoji/symbols removed | **alive** ✓ |
| F2 / F3 | 26 / 28 blocks per chapter | alive / dead |
| **G1** | only astral-plane pictographs removed; arrows and bullets kept | **alive** ✓ — shipped rule |
| G2 | G1 plus arrows downgraded to ASCII | alive — unnecessary |

### V versus BB is the whole investigation in one row

Both have no CSS and no images. They differ in one thing: V keeps the real
chapter text, BB replaces it with stubs. V dies, BB lives. Everything before
that row was removing furniture from a burning house.

Z1 looks like it contradicts BB — it also used stubs and also died — but Z1 still
carried the stylesheet. **Two variables, one conclusion, no information.**

### Why it hid for a dozen rounds

Three conditions held simultaneously:

1. **epubcheck does not care.** The file is valid EPUB 3 by every formal measure.
2. **Both control books happened to contain zero emoji.** The comparison that
   would have exposed it instantly was never run, because nothing suggested
   running it.
3. **The character scan reported "none" — and it was wrong.** See below.

Any two of those and it falls out in an hour.

### The false negative, twice

The scan that should have found the emoji reported none, because at that point
the build wrote `🧠` as the numeric entity `&#x1f9e0;` — **plain ASCII at the
byte level**. The scanner read bytes. The emoji were invisible to the only
instrument pointed at them, and that instrument's clean report is what steered a
dozen rounds elsewhere.

Then it happened a second time: the first F1 applied the stripping regex *after*
`$.xml()` serialisation, by which point the pictographs were entities again — so
the regex matched nothing and the verification counter, reading the same bytes,
confirmed "0 emoji". A build that had removed nothing was reported as the
decisive test.

The rule that came out of it: **decode before you count**, and count from the
parsed document, never from the file. `stripPictographs` operates on text nodes
of a parsed tree for exactly this reason.

### Where the boundary is, and where it is not

`U+1F000`–`U+1FAFF`, pictographs only. Deliberately **not** "astral plane": CJK
Extension B lives at `U+20000` and one volume in the corpus carries `𡒉` twelve
times while displaying perfectly. A book must never lose a character of its own
language to a compatibility rule.

Arrows, bullets, ticks and dashes stay — another book carries 241 bullets and is
fine — which is what lets a diagram built from boxes and arrows survive intact
once the decorative icon in its heading is gone. `🧠 概念圖解` becomes
`概念圖解`: the label was always the text, the icon was always decoration.

**Untested:** `U+1FB00`–`U+1FFFF` (symbols for legacy computing, and unassigned
space). The upper bound was chosen to end below CJK Ext B, not measured.

---

## Three invalid tests, all self-inflicted

Worth naming, because each cost a device round-trip and each was avoidable:

1. **E — renaming a file does not make a new book.** A Kindle matches on
   metadata (title, `dc:identifier`), not filename. E was byte-identical to the
   book already on the device, so it was merged into it and served from the
   existing KFX cache. The test measured nothing.
2. **A/B/C/D — the controlled variable was not the moving one.** Four cover-page
   styles, cleanly isolated, all four passed. They passed because all four were
   *newly side-loaded*, while the failing books were *overwrites of existing
   ones* — the one difference nobody was controlling. Four passes did not mean
   four correct hypotheses; it meant the experiment was blind.
3. **The first X2/Y2 swap was contaminated**, and produced the exact opposite
   conclusion ("the image is the problem"). The clean rerun reversed it. An
   anchor conclusion that survives into later reasoning is expensive: everything
   built on it has to come down.

## Method notes

Extracted from what actually worked, versus what was merely reasonable:

- **When two similar objects behave differently, swap parts before listing
  hypotheses.** Seven single-variable removals produced nothing. The swap
  (X2/Y2) and the jump to the extreme (V, then BB) produced everything. Listing
  hypotheses feels like progress and is cheaper to generate than an experiment —
  which is precisely why it gets reached for first.
- **Strip to the known-good shape, then add back.** Removing one suspect at a
  time cannot find a cause that survives every individual removal. BB — "make it
  exactly as simple as a book that works" — was the first test capable of
  answering the question.
- **A one-variable test is only as good as the variables you did not think to
  hold.** Both invalid tests above were properly controlled on the axis being
  studied.
- **Decode before you count.** An instrument that reports "clean" and an instrument
  that cannot see are indistinguishable from the outside.
- **Bisection needs a monotone axis.** Block count worked (25 alive / 30 dead →
  the threshold is a specific block). Emoji *count* did not — 44 emoji alive, 57
  dead — because emoji are not distributed evenly and the count was never the
  mechanism. A quantity that correlates is not necessarily the axis.

## Not answered here

- **Why** a Kindle behaves this way. Only that it does, on the tested firmware
  (a Japanese-market device, 2026-08-01). Both rules are inferred from behaviour,
  not from documentation.
- Whether other readers are affected. Both fixes are inert elsewhere — an unknown
  `<meta name>` is ignored, and removing decorative icons changes nothing for a
  reader that was fine with them — so no reader was regression-tested.
- The exact upper bound of the harmful range (see above).
- Whether the two failures share one mechanism inside the KFX converter. They
  present identically, which is suggestive and nothing more.
