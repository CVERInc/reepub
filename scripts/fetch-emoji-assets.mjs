#!/usr/bin/env node
// fetch-emoji-assets.mjs — put the monochrome emoji typeface and its names
// where `--emoji glyph` can find them.
//
// Glyph mode redraws every pictograph as line art: Noto Emoji's monochrome
// face rendered to a small image that sits in the text at 1em, with the
// character's CLDR name as its alt text. The typeface is the whole point —
// a colour emoji flattened to sixteen grey levels is mush, while these are
// drawn as strokes, like the arrows and bullets that were always safe. The
// names matter the same way: an image whose alt says 火箭 is still a rocket
// to a screen reader, to search, and to any future reader that loses the
// image.
//
// Everything is pinned and checksum-verified, like fetch-epubcheck.mjs and
// for the same reason: a silently different font would redraw every book
// that trusts this mode, and a drifted name table would relabel them.
//
//   node scripts/fetch-emoji-assets.mjs      # fetch if missing, verify, print dir
//
// Sources (both pinned):
//   Noto Emoji  — google/fonts @ b979dba, ofl/notoemoji (SIL OFL 1.1)
//   CLDR names  — unicode-org/cldr-json v48.2.0, annotations en / ja / zh-Hant

import { createHash } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "1";
const FONTS_COMMIT = "b979dba422e445492b0eb9951ac52ee0b4d648c3";
const CLDR_TAG = "48.2.0";

const ASSETS = [
  {
    name: "NotoEmoji.ttf",
    url: `https://raw.githubusercontent.com/google/fonts/${FONTS_COMMIT}/ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf`,
    sha256: "de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551",
  },
  ...[
    ["en", "f22083cb86dffb63a643d5bacb5d9899f82d2fa5d388ad4f3aed72184acef505"],
    ["ja", "737ce4bea3d52d904f7744eb7653ea55100c99232255609a913f69a5a8c3d6c1"],
    ["zh-Hant", "59158786a4a0b0937a7f3a370cbe5bc79ae7f3a6155edd55914dceadf0f0a35f"],
  ].map(([locale, sha256]) => ({
    name: `annotations-${locale}.json`,
    url: `https://raw.githubusercontent.com/unicode-org/cldr-json/${CLDR_TAG}/cldr-json/cldr-annotations-full/annotations/${locale}/annotations.json`,
    sha256,
  })),
];

export const assetsDir = join(homedir(), ".cache", "reepub", `emoji-glyphs-${VERSION}`);

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}

export async function ensureAssets() {
  const missing = [];
  for (const asset of ASSETS) {
    if (!(await exists(join(assetsDir, asset.name)))) missing.push(asset);
  }
  if (missing.length === 0) return assetsDir;

  await mkdir(assetsDir, { recursive: true });
  for (const asset of missing) {
    console.error(`fetching ${asset.name}…`);
    const response = await fetch(asset.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`${asset.url} responded ${response.status} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error(`checksum mismatch for ${asset.name}\n  expected ${asset.sha256}\n  got      ${digest}`);
    }
    await writeFile(join(assetsDir, asset.name), bytes);
  }
  return assetsDir;
}

// Run directly: fetch and print the directory, exactly like fetch-epubcheck.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  try {
    console.log(await ensureAssets());
  } catch (err) {
    console.error(`fetch-emoji-assets: ${err.message}`);
    process.exit(1);
  }
}
