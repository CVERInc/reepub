#!/usr/bin/env node
// preview-cover.mjs — look at a cover the way the shelf does.
//
// A cover judged at full size on a backlit display is not the cover anyone
// sees. A Kindle shows it in greyscale, about 230px wide, and draws its own
// furniture over three of its corners. Every one of those turns a design
// decision into a different design: a deep navy becomes flat grey, a 0.3-alpha
// imprint line disappears, a hairline frame is gone, and the author sits under
// the selection tick.
//
// This renders both — the cover as drawn and the cover as shown — and reports
// what actually survives.
//
//   node scripts/preview-cover.mjs <book.epub> [out.png]
//   node scripts/preview-cover.mjs --title 鹿鼎記 --author 金庸 [--rtl] [out.png]

import { mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { generateCover } = require("../src/cover-generator.js");

// What a library grid gives a cover, and where the shelf paints its own marks.
const SHELF_WIDTH = 230;
const FURNITURE = [
  { corner: "top right", label: "progress" },
  { corner: "bottom left", label: "selection tick" },
  { corner: "bottom right", label: "overflow menu" },
];

const args = process.argv.slice(2);
if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  console.log(`Look at a cover the way the shelf does.

  node scripts/preview-cover.mjs <book.epub> [out.png]
  node scripts/preview-cover.mjs --title <title> --author <author> [--translator <name>] [--rtl] [out.png]

Writes a sheet showing the cover as drawn beside the cover as a greyscale
shelf thumbnail, and prints what survives the trip.`);
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? "" : args[i + 1];
};
const positional = args.filter((a, i) =>
  !a.startsWith("--") && !["--title", "--author", "--translator"].includes(args[i - 1]));

const scratch = await mkdtemp(join(tmpdir(), "reepub-preview-"));
try {
  let coverPath;
  let subject;

  if (positional[0] && positional[0].endsWith(".epub")) {
    const epub = resolve(positional[0]);
    if (!existsSync(epub)) fail(`file not found: ${epub}`);
    execFileSync("unzip", ["-qo", epub, "-d", scratch]);
    coverPath = await findCover(scratch);
    if (!coverPath) fail(`${positional[0]} declares no cover image`);
    subject = positional[0].replace(/^.*\//, "");
  } else {
    const title = flag("--title");
    if (!title) fail("give an .epub, or --title and --author");
    coverPath = join(scratch, "cover.jpeg");
    const fit = await generateCover(title, flag("--author"), coverPath, {
      pageDirection: args.includes("--rtl") ? "rtl" : "ltr",
      translator: flag("--translator"),
    });
    subject = `${title} (${fit.layout}, title fitted to ${fit.titleScale}% of the canvas, ${fit.singleLine ? "one line" : "wrapped"})`;
  }

  const out = resolve(positional.find(p => p.endsWith(".png")) || "cover-preview.png");
  const shelf = await sharp(coverPath).greyscale().resize({ width: SHELF_WIDTH }).toBuffer();
  const drawn = await sharp(coverPath).resize({ width: 460 }).toBuffer();
  const shelfMeta = await sharp(shelf).metadata();
  const drawnMeta = await sharp(drawn).metadata();

  await sharp({
    create: {
      width: 460 + SHELF_WIDTH + 72,
      height: Math.max(drawnMeta.height, shelfMeta.height) + 48,
      channels: 3,
      background: { r: 244, g: 243, b: 240 },
    },
  })
    .composite([
      { input: drawn, top: 24, left: 24 },
      { input: shelf, top: 24, left: 460 + 48 },
    ])
    .png()
    .toFile(out);

  // The numbers that decide whether any of it arrives.
  const stats = await sharp(shelf).stats();
  const ink = stats.channels[0];
  const contrast = (ink.max - ink.min) / 255;

  console.log(`\n${subject}`);
  console.log(`  shelf tile      ${shelfMeta.width}x${shelfMeta.height}, greyscale`);
  console.log(`  tone            min ${ink.min}, max ${ink.max}, mean ${Math.round(ink.mean)}`);
  console.log(`  ink contrast    ${(contrast * 100).toFixed(0)}%`);
  console.log(`  ground          ${ink.mean < 128 ? "dark — bleeds into the lock screen's padding" : "light — reads as paper"}`);
  console.log(`  shelf draws over ${FURNITURE.map(f => `${f.corner} (${f.label})`).join(", ")}`);
  console.log(`\n  written to ${out}\n`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

async function findCover(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (/cover\.(jpe?g|png)$/i.test(entry.name)) return p;
    }
  }
  return null;
}

function fail(message) {
  console.error(`preview-cover: ${message}`);
  process.exit(1);
}
