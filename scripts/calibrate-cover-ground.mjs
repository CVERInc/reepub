#!/usr/bin/env node
// calibrate-cover-ground.mjs — find the grey a reader pads a cover with.
//
// A cover is almost never the shape of the screen it lands on, so the reader
// fills the difference. On a Kindle lock screen that fill runs down both sides
// of the cover, and it is not pure black: measured off a photograph it sits
// around ten luminance units above #000, which is enough to draw a visible
// seam down a black cover.
//
// The value is not published — Amazon documents cover sizes and says nothing
// about the fill — so it has to be measured off the device. This builds the
// instrument: a book whose cover is a ladder of greys, each band labelled with
// its own value. Put it on the reader, open it so it becomes the current book,
// let the screen lock, and photograph it. The band whose edge disappears into
// the fill IS the fill.
//
// One photograph settles it, and the answer belongs in a constant with this
// script named beside it — so anyone whose device disagrees knows exactly how
// to disagree with evidence.
//
//   node scripts/calibrate-cover-ground.mjs [out.epub]

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { newUuid, buildOpf, buildNcx, buildNavDocument, HREFS } = require("../src/binder.js");
const { CANVAS } = require("../src/cover-generator.js");

// E-ink renders sixteen levels of grey, so 0–255 arrives in steps of about
// seventeen. Bands finer than that cannot be told apart on the device — the
// first run of this ladder used two-level steps through the likely range and
// the observers reported, correctly, that neighbouring bands were nearly
// indistinguishable. They were asking the display for a distinction it does
// not have.
//
// So the ladder is one band per level the device can actually show, plus the
// midpoints on either side of the answer already found. Anything finer is
// false precision; the question is which level the fill lands on, not which
// hex value it was authored as.
const LEVELS = 16;
const STEP = 255 / (LEVELS - 1);
const STEPS = [
  ...Array.from({ length: 6 }, (_, i) => Math.round(i * STEP)),
  0x18, 0x28,
].sort((a, b) => a - b);

const hex = (v) => `#${v.toString(16).padStart(2, "0").repeat(3)}`;

async function buildLadder() {
  const bandHeight = Math.floor(CANVAS.height / STEPS.length);
  const height = bandHeight * STEPS.length;

  // The label sits in the middle of the band. The edges stay untouched — they
  // are the thing being compared against the fill, and ink near them would be
  // the one thing that could make the seam hard to see.
  const rows = STEPS.map((value, i) => {
    const y = i * bandHeight;
    const light = value < 0x24;
    return `<rect x="0" y="${y}" width="${CANVAS.width}" height="${bandHeight}" fill="${hex(value)}"/>`
      + `<text x="${CANVAS.width / 2}" y="${y + bandHeight / 2 + 22}" font-family="monospace"`
      + ` font-size="58" font-weight="bold" text-anchor="middle"`
      + ` fill="${light ? "#8a8a8a" : "#000000"}">${hex(value)}</text>`;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${height}">`
    + `<rect width="100%" height="100%" fill="#000"/>${rows}</svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

const outputPath = resolve(process.argv[2] || "reepub-cover-ground-calibration.epub");
const scratch = await mkdtemp(join(tmpdir(), "reepub-calibrate-"));

try {
  const oebps = join(scratch, "OEBPS");
  await mkdir(join(oebps, HREFS.imagesDir), { recursive: true });
  await mkdir(join(scratch, "META-INF"), { recursive: true });

  await writeFile(join(oebps, HREFS.imagesDir, "cover.jpeg"), await buildLadder());
  await writeFile(join(scratch, "mimetype"), "application/epub+zip");
  await writeFile(join(scratch, "META-INF", "container.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  const page = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en">
<head><meta charset="UTF-8" /><title>${title}</title></head>
<body>${body}</body>
</html>`;

  await writeFile(join(oebps, HREFS.coverPage), page("Cover",
    `<div style="text-align:center;margin:0;padding:0">`
    + `<img src="${HREFS.imagesDir}cover.jpeg" alt="Calibration ladder"`
    + ` style="width:100%;height:auto;display:block" /></div>`));

  await writeFile(join(oebps, "1.xhtml"), page("How to read this",
    `<h1>Cover ground calibration</h1>
     <p>Open this book so the reader makes it the current one, then let the
     screen lock. The reader fills the difference between this cover's shape
     and the screen's with a grey of its own, down both sides.</p>
     <p>Photograph the lock screen and look along either edge. Most bands show
     a faint step where they meet the fill. One does not — its edge simply
     disappears. That band's label is the fill colour.</p>
     <p>Both display themes were reported to fill with the same grey; photograph
     each if you want that on the record too.</p>`));

  const uuid = newUuid();
  const chapters = [{ id: "how", href: "1.xhtml", title: "How to read this" }];
  await writeFile(join(oebps, "content.opf"), buildOpf({
    version: "3.0",
    title: "Cover ground calibration",
    creator: "reepub",
    language: "en",
    uuid,
    modified: new Date(0),
    chapters,
    images: ["cover.jpeg"],
    coverImage: `${HREFS.imagesDir}cover.jpeg`,
  }));
  await writeFile(join(oebps, HREFS.ncx), buildNcx({ title: "Cover ground calibration", uuid, chapters }));
  await writeFile(join(oebps, HREFS.nav), buildNavDocument({ title: "Cover ground calibration", chapters }));

  execFileSync("rm", ["-f", outputPath]);
  execFileSync("zip", ["-0Xq", outputPath, "mimetype"], { cwd: scratch });
  execFileSync("zip", ["-ur9q", outputPath, "META-INF", "OEBPS"], { cwd: scratch });

  console.log(`Wrote ${outputPath}`);
  console.log(`  ${STEPS.length} bands, ${hex(STEPS[0])} to ${hex(STEPS[STEPS.length - 1])}`);
  console.log("  Side-load it, open it, lock the screen, photograph it.");
  console.log("  The band whose edge vanishes into the side fill is the fill colour.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
