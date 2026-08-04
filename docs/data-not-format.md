# What survives a conversion, and what is supposed to be lost

Every tool in reepub converts something into something else. This is the ledger
of what each conversion must carry across and what it is *correct* to drop.

The rule it is built on:

> **What a conversion preserves is the data, not the format.** Saving HTML as
> Word and back gives you something that looks similar and has stopped meaning
> anything. That is the failure, and it is the same one as an "EPUB" that is
> page images glued together: the appearance survived and the content did not.

reepub has always been on this side of that line — turning a scan into
reflowable paragraphs *is* discarding the format to recover the data. Writing
the rule down only makes it usable by the next conversion instead of only the
first one.

## Why this file exists

It is four things at once, which is why it is worth the page:

1. the specification of the book format reepub reads and writes;
2. the specification of the round-trip check — it says what that check compares;
3. the manifest for the fixture corpus;
4. the go/no-go on whether markdown can be the intermediate representation at
   all. **That verdict is at the bottom, and it is conditional.**

---

## The two kinds of page

A page is not one thing. The distinction is load-bearing and it decides which
column of the table below applies.

| kind | a page is | when it is decided | example |
|---|---|---|---|
| **fixed** | a fixed visual unit | intrinsic — the source *is* pages | a comic, a plate, a scanned PDF page kept as an image |
| **flow** | a run of reflowable content | computed at view time, from type size and screen | a novel, a blog post, prose recovered by OCR |

For a comic, the page is **data**: the artist composed it, the spread is
deliberate, panel order depends on it. For a scanned novel, the page is
**format**: an artifact of the paper it happened to be printed on, and
preserving it is the "image-glued fake EPUB" reepub exists to refuse.

reepub already computes which one it is looking at:
`ScanOCR.textPageMinimumCharacters = 120` is that classifier
(see [measured-constants.md](measured-constants.md)).

---

## The ledger

**Data** must survive every conversion, in both directions. **Format** is
correct to drop — dropping it is the tool working, not a defect, and it must
not be reported as one. Reporting every discarded `<span class>` is noise;
losing a reading direction is a book that opens backwards.

| property | flow | fixed | where it lives in markdown |
|---|---|---|---|
| title, author, translator | **data** | **data** | frontmatter |
| language | **data** | **data** | frontmatter |
| reading direction (ltr/rtl) | **data** | **data** | frontmatter — see below |
| chapter boundaries and order | **data** | **data** | `#` headings, source order |
| paragraph text | **data** | **data** | prose |
| paragraph boundaries | **data** | n/a | blank lines |
| heading level | **data** | **data** | `#` depth |
| list items and their order | **data** | **data** | `*` / `-` / `+` lines |
| inline links (label and target) | **data** | **data** | `[label](url)` |
| a heading inside a blockquote | **data** | **data** | `> #` — a heading, and quoted |
| a chapter with a title and no body | **data** | **data** | `#` with nothing under it |
| images and their order | **data** | **data** | embed lines |
| image alt text | **data** | **data** | inside the embed |
| plate pages | **data** | **data** | a page holding an image |
| page boundaries | *format* | **data** | `##` headings (fixed only) |
| cover identity | **data** | **data** | frontmatter |
| emphasis (bold/italic) | **data** | **data** | `**` / `*` |
| per-chapter CSS | *format* | *format* | — |
| fonts, type size, leading | *format* | *format* | — |
| spine order distinct from nav order | *format* | *format* | — |
| XHTML wrapper, doctype, namespaces | *format* | *format* | — |
| which embed form an image used | *format* | *format* | preserved anyway, see note |
| whitespace and line wrapping in source | *format* | *format* | — |

### Reading direction looks like format and is data

It is the sharpest case in the table and the reason the rule needs writing down
rather than intuiting. Direction reads like typography — it is not. An EPUB
missing its `primary-writing-mode` metadata has its **cover and table of
contents hidden for the entire book** by Amazon's converter, while passing
epubcheck at zero errors and rendering its text correctly. That was established
over roughly forty builds delivered to hardware one at a time
([kindle-silent-failures.md](kindle-silent-failures.md)).

A property whose absence decides whether the book opens at all is data, whatever
it looks like.

### The embed form is format, and is preserved anyway

`![[cover.png]]` and `![](cover.png)` carry identical data. The family's parser
round-trips whichever form it read, because a tool that silently rewrote a
person's file — even into an equivalent — has edited their document without
being asked. Preserving format is allowed. **Depending** on it is not.

---

## The tool reports; the owner decides

Dropping format is the tool working. Dropping data is the tool failing. The
table above says which is which — but a tool cannot apply it, because the same
element is data in one edition and not in another, and only the person whose
book it is knows which.

So the rule is not "drop the right things". It is:

> **Carry everything, and say what did not make it.** A converter that decides
> what matters is deciding what the book is.

This was learned the expensive way on 2026-08-04. A 110-chapter EPUB was taken
apart, translated and rebuilt, and the rebuilt book was missing **30 images and
109 hyperlinks**. Nothing went red. The chapter count matched, epubcheck
reported zero errors, and eighty-two independent quality reviews never mentioned
them — because the step that dropped them handed on plain text, so nothing
downstream had ever seen them to miss. The loss had no error message. It had a
book that was smaller than the one it came from.

`sanitizeChapter` now takes a census before and after and returns what went, and
`buildWebEpub` collects one entry per chapter that lost something. Two numbers
per category, because *it was in the navigation bar* and *it vanished and nobody
knows where* are different reports, and only the second is a reason to go
looking.

It is a **record, not a promise** — nothing fails on a non-zero count. A gate
would have to rank the categories, and ranking them is the decision that belongs
to the owner.

The same line decides where an editorial judgement lives. Not restoring an
original publisher's logo into a translated edition is a decision about *that
edition*; it belongs to the person building it, written down with its reason. A
tool that made that call for everyone would be doing the thing this page exists
to refuse.

## What markdown cannot say

Frontmatter is where data goes when the syntax has no room for it. It is not a
dumping ground for format — the test for a key is the same as everywhere else on
this page: *would losing it change what the book means?*

Known gaps, in order of how much they hurt:

| gap | status | note |
|---|---|---|
| **ruby / 振り仮名** | ❌ no syntax | Furigana over kanji is pronunciation — unambiguously data in a Japanese book. Markdown has no form for it and neither does the family parser. |
| **footnotes** | ⚠️ extension only | CommonMark has none. Extension syntax exists and the family parser does not implement it. |
| **folio (printed page number)** | ❌ no syntax | Data when a book is cited by page, format when it is read. Currently dropped as a footer by design. |
| **figure captions bound to a figure** | ⚠️ by convention | Expressible as prose next to the embed; nothing enforces the binding. |
| **front matter / back matter distinction** | ⚠️ by convention | A colophon and chapter one are both `#` headings. |

---

## The round-trip contract

The check compares **data, not bytes**. Byte identity is the wrong test: it
would force the tools to preserve format, which is the exact failure this page
exists to prevent, and it would be red forever.

What is asserted:

```
serialize(parse(serialize(x))) == serialize(x)     // idempotent, not identical
parse(md).chapters.length      preserved
chapter order                  preserved
image list and order           preserved
reading direction              preserved
normalized text content        preserved
```

The first serialize normalizes the format; from there it must be a fixpoint.
This is not a new invention — it is the shape the tile family already runs in
three places (`sitetile`, `book-core`, `cardtile`), and reepub's version should
be recognizably the same test.

**The fixture corpus is the gate, and as of 2026-08-04 it is running.** One
directory of `.md` files, parsed by both implementations —
`EpubKit/BookMarkdown.swift` behind the `book-md` CLI, and the JavaScript parser
inside `scripts/check-book-format.mjs` — compared on the data columns above.
Two parsers of one written format is not the trap of two undocumented
implementations claiming agreement in a comment (PRINCIPLES §6); the difference
is precisely that the format is written down and something runs both sides
against it.

The JavaScript side was written from this page rather than from the Swift.
That is deliberate and it is the only thing keeping the gate honest: reading the
other implementation is how two parsers come to agree about something neither of
them got right.

### What the fixpoint check does not prove

The round-trip assertion passed on all 11 fixtures and all 110 chapters of a
real book while the parser was still splitting every source line into its own
paragraph — the ledger puts paragraph boundaries in the **data** column and
source line wrapping in the **format** column, and the parser had them
confused. It round-tripped perfectly, because it was wrong the same way twice.

**Idempotence proves stability, not correctness.** The bug surfaced only when
the parsed structure was read back and compared against what the fixture claimed
to be. That is why the gate asserts both, and why the corpus has to carry
fixtures whose *shape* is known independently of any parser.

The corpus must include at least one fixture per hazard: a right-to-left book, a
vertical CJK book, a book of plates with no prose, a book of prose with no
images, a book of prose interrupted by a plate, a chapter whose title contains
XML specials, an astral-plane title (where JavaScript counts UTF-16 units and
Swift counts graphemes), a fenced code block containing headings, a heading
inside a blockquote, a chapter containing a list, a book with an empty chapter,
and a chapter containing an inline link.

### The last three came from a book, not from this page

The first eight hazards were reasoned out. The last three were found the way
hazards are actually found — by running a real 110-chapter book through a
converter and reading what came out (`experiments/epub-teardown/naval-teardown`,
2026-08-04). Each one had already shipped as a visible defect before anybody
thought to name it:

- **a heading inside a blockquote.** Nine chapters carried `> # sentence`. A
  converter that strips `> ` and then wraps the remainder in a paragraph prints
  a literal `#` into the finished book. Nothing in the eight reasoned hazards
  covers a construct nested inside another construct.
- **a list.** This table had no row for lists at all, so a converter with no
  list branch dropped `* item` into prose and nothing said it was wrong. A
  property missing from the spec cannot be lost — it was never promised.
- **an empty chapter.** One chapter of the 110 had a title and no body, and the
  builder needed a special case to keep it in the spine.
- **an inline link.** The table had no row for links either, so the Swift parser
  kept `[label](url)` as paragraph text and the book printed it verbatim —
  ninety-six times. Found the same way and on the same day, which is the point:
  the corpus grows by contact with books, not by thinking harder about it.

Worth stating plainly, because it predicts where the next gap is: **this page
was written by reasoning about a format, and reasoning found eight of twelve.**
The corpus is the part that gets better by contact with books.

`scripts/check-book-format.mjs` holds that list and fails when this paragraph
and `fixtures/book-md/` stop agreeing — in either direction. A hazard named here
with no fixture is a gap; a fixture answering no hazard is one nobody will
maintain.

---

## Verdict: can markdown be the intermediate representation?

**Yes — for what reepub extracts today. Conditionally, and here is the
condition.**

Everything in the data columns above has somewhere to live: frontmatter for what
has no syntax, headings for structure, embeds for images. Nothing reepub
currently recovers from a scan would be lost by routing it through markdown.

The gaps are real but not yet reachable: reepub does not recover ruby today —
Vision returns furigana as separate small lines that are already discarded or
mangled — nor footnote binding, nor folios (they are deliberately dropped as
running feet). **Markdown cannot lose what the OCR never produced.**

So the condition is a tripwire rather than a blocker:

> 🔴 **The day reepub's extraction improves enough to recover ruby, footnote
> binding, or folios, this verdict must be revisited before that data is routed
> through markdown.** Getting better at reading a book is exactly the change
> that would silently start throwing away what it newly understood.

That is worth stating plainly because of how it would fail: not with an error,
but with a better OCR quietly producing the same book as before.
