#!/usr/bin/env node
// fetch-epubcheck.mjs — put the official EPUB validator where the test suite
// can find it.
//
// reepub ships its own dependency-free validator so that validation always
// runs, but the project's promise is that a finished book passes the REAL
// epubcheck. That claim is only worth making if CI can check it, and CI can
// only check it if the jar is reliably obtainable — hence this script rather
// than a README instruction nobody follows.
//
// The download is cached, checksum-verified and idempotent: run it as often as
// you like. Prints the resolved jar path on stdout.
//
//   node scripts/fetch-epubcheck.mjs          # fetch if missing, verify, print path
//   REEPUB_EPUBCHECK_JAR=/path/to.jar ...     # or point at your own copy

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const VERSION = "5.1.0";
const URL = `https://github.com/w3c/epubcheck/releases/download/v${VERSION}/epubcheck-${VERSION}.zip`;
// sha256 of the released zip. A mismatch means the bytes are not the ones this
// project was tested against, which is a hard stop rather than a warning: a
// silently different validator would make every downstream "0 errors" a guess.
const SHA256 = "74a59af8602bf59b1d04266a450d9cdcb5986e36d825adc403cde0d95e88c9e8";

const cacheDir = join(homedir(), ".cache", "reepub", `epubcheck-${VERSION}`);
const jarPath = join(cacheDir, "epubcheck.jar");

const override = process.env.REEPUB_EPUBCHECK_JAR;
if (override && (await exists(override))) {
  console.log(override);
  process.exit(0);
}

if (await exists(jarPath)) {
  console.log(jarPath);
  process.exit(0);
}

console.error(`fetching epubcheck ${VERSION}…`);
const zipPath = join(tmpdir(), `epubcheck-${VERSION}-${process.pid}.zip`);
try {
  const response = await fetch(URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`${URL} responded ${response.status} ${response.statusText}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== SHA256) {
    throw new Error(`checksum mismatch for epubcheck ${VERSION}\n  expected ${SHA256}\n  got      ${digest}`);
  }

  await writeFile(zipPath, bytes);
  await mkdir(cacheDir, { recursive: true });
  // -j flattens the release's epubcheck-X.Y.Z/ prefix into the cache dir.
  execFileSync("unzip", ["-qo", zipPath, "-d", join(cacheDir, "..")], { stdio: "inherit" });

  if (!(await exists(jarPath))) {
    throw new Error(`epubcheck.jar was not where the archive was expected to put it (${jarPath})`);
  }
  console.error(`epubcheck ${VERSION} ready`);
  console.log(jarPath);
} catch (err) {
  console.error(`fetch-epubcheck: ${err.message}`);
  process.exit(1);
} finally {
  await rm(zipPath, { force: true });
}

async function exists(p) {
  try {
    await access(p, constants.R_OK);
    return true;
  } catch (_) {
    return false;
  }
}
