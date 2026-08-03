# Principles

What reepub promises, and what it forbids itself in order to keep the promise.

Each principle below carries a **Forbidden** clause. Those clauses are not
aspirational — a machine asserts every one of them and CI fails the build when
one is violated. Most are static rules in `scripts/check-release-readiness.mjs`;
§6 is enforced by `scripts/check-sync-markers.mjs` and §7 by the spec suites,
because what those two forbid is a property of the *output*, which no pattern in
the source can catch. Each principle names its own enforcer, so that this
paragraph cannot quietly become false as the set grows.

A promise nothing can check is marketing.

---

## 1. Offline by architecture

Your books cannot leave the machine, because there is nothing in the program
that could send them. No API key, no account, no telemetry, no cloud OCR. The
local web UI exists for convenience and binds to loopback only, so it is not a
door onto your network.

**Forbidden**

- Any outbound network call in the conversion path.
- Any bundled API key, endpoint, or analytics identifier.
- Any listener bound to an address other than `127.0.0.1`.
- Any endpoint that accepts a caller-supplied filesystem path. Uploads are
  addressed by opaque, server-issued ids, so "read or delete an arbitrary file"
  is not an attack that was blocked — it is a request that cannot be expressed.

## 1a. The source stays readable, because the promise depends on it

The claim above — *privacy that's structural, not a promise* — is only true if
you can check it. A closed binary saying "there is no outbound call in the
conversion path" is a promise; the same sentence over readable source is a
fact anyone can verify in an afternoon. Closing the source would not weaken the
guarantee a little, it would convert it into the exact kind of assurance
Principle 1 exists to replace.

So the app is not the thing being sold, and it will not become it. What can
honestly be sold is **convenience that costs us money or time and costs you
neither**: a signed and notarized build, automatic updates, and not needing
Xcode to get a working copy. None of those change what the program does; all of
them change how much work it is to have it. Ruled 2026-08-03.

**Forbidden**

- Shipping a build whose corresponding source is not public under the same terms.
- Putting any conversion capability behind a paid tier. The paid thing is
  delivery, never behaviour.
- Framing the free build as a trial, a "community edition", or feature-limited.

## 2. Never ship an invalid book

A book that fails validation is deleted, and the command exits non-zero. The
alternative — printing a warning and leaving the file on disk — is how reepub
once shipped a 15-chapter book in which every chapter was missing its `<body>`
element. The build said `✓ EPUB valid`. The official epubcheck said 45 errors.

The built-in validator is dependency-free so that it always runs. It is not the
final authority: `npm test` runs the real
[epubcheck](https://github.com/w3c/epubcheck) against a freshly built book and
requires **0 fatals / 0 errors / 0 warnings**.

**Forbidden**

- Writing an artifact that failed validation.
- Logging a validation failure and exiting `0`. In practice this means no
  pipeline may end in `.catch(console.error)`.

## 3. One assembly path

Every package document, NCX and navigation document **on the Node side** is built
by `src/binder.js`. Nothing else there may emit one.

The native app is the acknowledged exception, and stating it is the point:
`macos/Sources/ReepubCore/EpubBuilder.swift` assembles its own package document,
NCX and navigation document. The guard in `src/test-core-spec.js` reads `.js`
files only, so it has never once seen that half — a gate nobody has watched fail
is not evidence of a boundary. Until the assembly core moves to Swift (decided
2026-08-02, see HANDOFF.md), this section describes one language, not the
project.

This is not tidiness. reepub previously had three hand-rolled `<package>`
templates that drifted apart: one escaped its inputs and two did not, one
emitted EPUB 3 without the navigation document the format requires, and one
minted its identifier twice so the NCX and the package disagreed about what
book they described. Those were not three bugs to fix. They were one missing
boundary, and the class disappeared when the boundary appeared.

The same rule applies to the other shared edges: `src/sanitizer.js` for
HTML→XHTML, `src/dehydrator.js` for images, `src/epub-text.js` for escaping and
the OCR heuristics it keeps in step with the Swift builder.

**Forbidden**

- A `<package` template outside `src/binder.js`.
- A second implementation of escaping, image optimization, or the paragraph
  heuristics.

## 4. Heal what you can, and say so

Ebooks in the wild are broken. The vertical right-to-left CJK volumes we tested
carry four epubcheck errors each: an EPUB 3 spine
attribute on an EPUB 2 package, a table of contents whose identifier disagrees
with the package, and an `@font-face` pointing at `res:///system/fonts/…`, an
Android system font that no other reader can load.

`reepub merge` repairs all four. Merging such a set turns every one of those
inherited errors into a single book with none.

Repair is never silent. Anything removed from someone's book is named on
stdout, because rewriting a stranger's work without telling them is worse than
leaving it broken.

**Forbidden**

- Dropping or rewriting any part of an input book without reporting it.
- Guessing at a repair. An unknown named entity fails the merge rather than
  being silently mangled into something that looks plausible.

## 5. Restraint

reepub converts documents you own into clean, reflowable EPUBs on your own Mac.
It is not a library manager, a reader, a sync service, or a store.

Runtime dependencies: `cheerio`, `sharp`, `playwright`. Everything else — OCR,
validation, packaging — is the platform or this repository.

**Forbidden**

- A dependency the README does not need.
- Scope the README does not promise.

## 6. Node and Swift stay honest with each other

The CLI (`src/epub-text.js`) and the macOS app
(`macos/Sources/ReepubCore/EpubBuilder.swift`) reimplement the same OCR
heuristics in two languages, so the same PDF must produce the same book from
either. That claim used to be a comment, and it was false in three places —
including a paragraph-break rule that disagreed on `“` and a heading rule that
measured a Traditional-Chinese title as 50 characters in one language and 25 in
the other.

`scripts/check-sync-markers.mjs` now extracts the rules from both sources and
compares them, so drift is caught by CI rather than by an audit.

**Forbidden**

- Changing a shared heuristic on one side only.
- A sync claim that only a comment asserts.

## 7. A book a Kindle will not quietly maim

A book that validates is not the same as a book a reader can open. Two
constructs make Amazon's EPUB→KFX converter hide the cover **and** the table of
contents of the entire book — not the chapter at fault, the whole book — while
the file passes epubcheck with 0 errors and the reading text renders fine: an
RTL book with no `primary-writing-mode` metadata, and pictographic emoji
anywhere in the text.

Neither appears in any specification. They were found by bisection over ~40
builds delivered through Amazon's own Send to Kindle uploader, one at a time, on
hardware; roughly thirty-five of those builds existed only to kill a hypothesis.
The disproof ledger — including the three tests that turned out to be measuring
nothing — is in [`docs/kindle-silent-failures.md`](docs/kindle-silent-failures.md).

**Forbidden**

- Emitting `page-progression-direction="rtl"` without the writing-mode metadata
  that keeps the cover reachable.
- Letting a pictograph reach a chapter by default.
- Widening that range into a book's own language. CJK Extension B is text;
  arrows and bullets are diagram. A compatibility rule that quietly grows is
  worse than the defect it fixes, because it costs the reader content they
  cannot see is missing.

Asserted by `src/test-web-spec.js`, `src/test-core-spec.js` and
`macos/Sources/ReepubSelfTest/main.swift` — three suites rather than one,
because the rule has to hold in both assemblers and §6 is what keeps them from
disagreeing about it.

---

> These principles were rewritten on 2026-08-01 after an audit found that
> several of the project's stated guarantees were not true. Each one now names
> the failure it exists to prevent, so that a future reader can tell the
> difference between a rule that was earned and a rule that sounded good.
