# Book-format fixtures

One `.md` per hazard named in [`docs/data-not-format.md`](../../docs/data-not-format.md).

These exist so that the day a second implementation parses this format, there is
something to compare it against that was chosen before either parser was
written. A fixture set assembled after the fact tests what the code already
does.

`scripts/check-book-format.mjs` asserts this directory stays complete against
the ledger — a hazard added to the ledger with no fixture here is a gap the
machine finds, not the next reader.

Two provenances, and it is worth knowing which a fixture has. Eight of these
were reasoned out from the format. Three — `heading-inside-blockquote.md`,
`bulleted-list.md`, `empty-chapter.md` — were found by putting a real
110-chapter book through a converter on 2026-08-04 and reading the result; every
one of them had already shipped as a visible defect. Reasoning found eight of
eleven, which is the honest hit rate to expect from the next reasoned hazard.
