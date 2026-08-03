# Changelog

All notable changes to reepub are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.0] - 2026-08-04

An audit found that several of reepub's stated guarantees were not true. Books
it had already produced were invalid, and the validator that was supposed to
catch that had passed them. This release makes the guarantees real and adds the
CI that keeps them that way. See [PRINCIPLES.md](PRINCIPLES.md).

### Added — emoji as engravings (`heal --emoji glyph`)

- For books where the emoji are content — a legend, a rating, a bullet —
  stripping would delete meaning. Glyph mode redraws each pictograph in
  place as monochrome line art: Noto Emoji's monochrome face, one engraving
  per distinct character (content-addressed, so 77 emoji cost 18 small
  images), set into the text at 1em so it scales with the reader's chosen
  type size, flush with the em box (vertical-align: text-bottom, judged on
  the device against middle and a negative offset — a CJK character fills
  its em box, so the glyph stands shoulder to shoulder with the characters
  around it). The alt text is the character's CLDR name in the book's
  language — 火箭 to a screen reader and to search, an image to the eye.
  The pictograph codepoint itself — the thing that kills the cover — never
  reaches the book. Assets are pinned and checksum-verified
  (`scripts/fetch-emoji-assets.mjs`); a glyph the face cannot draw stops
  the run rather than letting the colour font it exists to avoid stand in.
- `--emoji strip|glyph|keep` on heal; strip remains the default.
- The heal path now decodes numeric character references before its emoji
  handling, so a pictograph written as `&#x1f9e0;` — plain ASCII on disk —
  is treated exactly like one written as itself.

### Added — the native app catches up with the CLI

- The macOS app now offers the emoji decision to the reader: a toggle
  ("Remove emoji — Kindle compatibility", localized en/ja/zh-TW, on by
  default) and, after a build that removed any, a note saying how many —
  the same repair the CLI names, never done quietly. The shared pictograph
  range is now a machine-checked heuristic in `check-sync-markers.mjs`, so
  the two builders cannot quietly disagree about which characters a book
  may keep.
- The app's EPUBs now pass the official epubcheck clean. Its builder still
  had two defects the audit fixed on the Node side: it wrote EPUB 3
  packages with no navigation document, and the OPF and NCX each minted
  their own timestamp-based identifier — two documents disagreeing about
  which book they describe, neither a valid UUID. One shared UUID and a
  declared `properties="nav"` document now; the self-test asserts both.

### Fixed — a valid book that no Kindle would show

- **Emoji in the text cost a book its cover and its entire table of contents.**
  Not the chapter containing them — the whole book. It opened on page one with
  no cover and no way to navigate, while the file was valid EPUB 3 and epubcheck
  passed it clean. `heal` and the web pipeline now remove pictographic emoji and
  report how many; `heal` names it as a repair rather than doing it quietly.

  Only pictographs go. Arrows, bullets and ticks stay, so a diagram built from
  boxes and arrows still reads as one, and the range stops short of U+20000
  where CJK Extension B lives — a volume in the test corpus carries 𡒉 twelve
  times and displays perfectly, so no book loses a character of its own
  language to this.

- Every non-ASCII character was written as a numeric reference on serialisation,
  so a Chinese chapter left the pipeline with 1227 escapes and not one readable
  glyph, each character costing eight bytes instead of three. All three
  serialisation sites now share one exit. This also hid the emoji above from
  every search over the file's bytes, where they appear as plain ASCII.

### Fixed — books that were already shipped were invalid

- EPUB 3 packages were written without the navigation document the format
  requires, so every book `src/builder.js` produced failed the official
  epubcheck. The identifier was not a valid UUID, and the NCX minted its own,
  so the table of contents and the package disagreed about what book they
  described.
- The web pipeline stripped the `<body>` element from every chapter and never
  put it back: a 15-chapter book scored 45 epubcheck errors while the build
  printed `✓ EPUB valid`.
- `merge` performed no XML escaping at all, so a title as ordinary as
  `AT&T 傳` produced malformed XML in three documents at once. It also flattened
  chapters into `OEBPS/` without rewriting their references, leaving an unstyled
  book with blank image pages, and passed OPF hrefs to `unzip` as shell globs,
  which failed outright on any filename containing a space or a bracket.
- The image optimizer assumed a content root of `OEBPS/`; run against the
  standard `EPUB/` layout it silently discarded every chapter and the package
  document, then exited `0`.

### Fixed — the local web UI

- `GET /convert` accepted a caller-supplied filesystem path and unconditionally
  deleted it, on both the success and failure paths. `GET /download` would serve
  and then delete any file in `bin/`, including the native OCR binary. The
  server bound `0.0.0.0`, so both were reachable from the local network.
- Uploads are now addressed by opaque, server-issued ids, the listener binds
  `127.0.0.1`, and uploads are size-capped and checked for a PDF signature.

### Fixed — validation

- The validator now rejects a content document with no `<body>`, an internal
  reference that does not resolve, and any path escaping the container. It no
  longer rejects valid books over an attribute on `<manifest>` or a commented-out
  `<item>`, because it parses XML instead of pattern-matching it.
- Scratch space moved to the system temp directory with a collision-proof name,
  and `validateEpub` no longer throws out of its `{success, error}` contract.

### Added

- `reepub heal` repairs a single broken EPUB: EPUB 2 packages using an EPUB 3
  spine attribute, mismatched table-of-contents identifiers, chapters still
  declaring the XHTML 1.1 doctype, and stylesheets pointing at fonts that cannot
  load. Five real volumes carrying four epubcheck errors each came out at zero,
  with every document and their vertical right-to-left layout intact. Healing
  never edits in place, everything changed is reported on stdout, and a repair
  that fails validation is deleted rather than handed back.
- `reepub merge` performs the same repairs on the volumes it combines, driven by
  the same engine, so the two cannot drift apart.
- `src/binder.js` is now the only module allowed to emit a package document,
  NCX or navigation document; `src/sanitizer.js` and `src/dehydrator.js` are the
  single HTML and image paths. The duplicated implementations they replace had
  already drifted apart.
- `npm test` runs the official epubcheck against a freshly built book and
  requires 0 errors and 0 warnings. `npm run epubcheck` fetches the jar once,
  checksum-verified, and CI uses the same script.
- `scripts/check-release-readiness.mjs` asserts the reverse constraints in
  PRINCIPLES.md: no non-loopback listener, no package template outside
  `binder.js`, no hardcoded personal paths, no pipeline that logs a failure and
  exits `0`.
- `scripts/check-sync-markers.mjs` now compares the OCR heuristics themselves
  between `src/epub-text.js` and `EpubBuilder.swift`, rather than a version
  marker. It found three real divergences, including a paragraph-break rule that
  disagreed on `“` and a heading rule that measured a Traditional-Chinese title
  as 50 characters in one language and 25 in the other.

### Added — binaries you can download

- `scripts/build-release.sh` builds `scan-ocr` and `epub-kit` as **universal**
  binaries (arm64 + x86_64), so a download works on the whole range of Macs the
  README's macOS 13 floor implies rather than only on Apple Silicon. Each slice
  is cross-compiled with `-target` and joined with `lipo`, because SwiftPM's own
  `--arch` needs xcbuild and this project deliberately builds with Command Line
  Tools alone. The script refuses to ship a binary that is missing a declared
  architecture or cannot print its own usage.
- v1.0.0 shipped with no release assets at all, which meant the only way to run
  any of this was to clone it and build it. These are unsigned — there is no
  Developer ID yet — so macOS quarantines them on first run; the release notes
  say how to clear it. No `.app` is published for the same reason: an unsigned
  app is blocked outright rather than quarantined with an escape hatch.

## [1.0.0]

- Initial public release: convert scanned PDFs into reflowable EPUB books using
  native macOS Vision OCR, fully offline.
