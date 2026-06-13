#!/usr/bin/env node
// check-release-readiness.mjs — CVER OSS shared delivery baseline (dim 7).
//
// One portable, dependency-free gate that every CVER repo can drop in. It proves
// three things before a release is allowed out the door:
//   1. The version is a single source of truth (every declared source agrees,
//      and a `vX.Y.Z` release tag matches it).
//   2. The CHANGELOG has an entry for the version being shipped.
//   3. The published artifact is clean (no node_modules / secrets / OS cruft /
//      lockfiles leaking into the tarball, and it stays under a size budget).
//
// Zero-config on a standard npm repo. Tune via an optional `.release-readiness.json`
// at the repo root. Run from the repo root: `node scripts/check-release-readiness.mjs`.
//
// Exit code 0 = ready. Non-zero = at least one hard failure. Warnings never fail.

import { readFile, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const failures = [];
const warnings = [];

const DEFAULTS = {
  // Where the version lives. Each entry is either a path string (a JSON file whose
  // `.version` is read) or { path, json } / { path, regex } for non-JSON sources
  // such as Package.swift or a shell constant. The first entry is the primary.
  versionSources: ["package.json"],
  // CHANGELOG handling. Set requireChangelog:false to downgrade a missing file to a warning.
  changelog: "CHANGELOG.md",
  requireChangelog: true,
  // Artifact hygiene. pack:true runs `npm pack --dry-run` and inspects the file list.
  // Set pack:false for repos that don't publish to npm (e.g. Apps Script, web demos).
  pack: true,
  maxPackBytes: 5 * 1024 * 1024,
  // Extra path patterns (regex strings) that must never appear in the tarball.
  forbidInPack: [],
};

const config = { ...DEFAULTS, ...(await readJsonOrNull(join(repoRoot, ".release-readiness.json"))) };

const version = await resolveVersion();
await checkVersionConsistency();
await checkReleaseTag();
await checkChangelog();
await checkPackHygiene();

report();

// ---------------------------------------------------------------------------

async function resolveVersion() {
  const primary = config.versionSources[0];
  const v = await readVersionSource(primary);
  if (v == null) {
    fail(`could not read a version from the primary source ${sourcePath(primary)}.`);
    return "0.0.0";
  }
  assert(isSemver(v), `primary version "${v}" (from ${sourcePath(primary)}) must be semver (X.Y.Z).`);
  return v;
}

async function checkVersionConsistency() {
  for (const source of config.versionSources.slice(1)) {
    const v = await readVersionSource(source);
    if (v == null) {
      fail(`version source ${sourcePath(source)} is declared but unreadable.`);
      continue;
    }
    assert(
      v === version,
      `version mismatch: ${sourcePath(source)} is "${v}" but primary is "${version}". ` +
        `Keep every version source in lockstep (single source of truth).`,
    );
  }
}

async function checkReleaseTag() {
  // On a tag push GitHub sets GITHUB_REF_NAME to the tag. Only enforce for vX.Y.Z tags.
  const ref = process.env.GITHUB_REF_NAME;
  if (ref && /^v\d/.test(ref)) {
    assert(ref === `v${version}`, `release tag ${ref} must match the package version v${version}.`);
  }
}

async function checkChangelog() {
  const path = join(repoRoot, config.changelog);
  if (!(await exists(path))) {
    const msg = `${config.changelog} not found; a changelog is the boundary-as-document for releases.`;
    config.requireChangelog ? fail(msg) : warn(msg);
    return;
  }
  const text = await readFile(path, "utf8");
  // Accept "## [1.2.3]", "## 1.2.3", "## v1.2.3" — common Keep-a-Changelog variants.
  const has = new RegExp(`^##\\s*\\[?v?${escapeRegex(version)}\\]?`, "m").test(text);
  assert(has, `${config.changelog} must contain a section for ${version} (e.g. "## [${version}]").`);
  if (!/^##\s*\[?Unreleased\]?/im.test(text)) {
    warn(`${config.changelog} has no [Unreleased] section to collect the next cycle's changes.`);
  }
}

async function checkPackHygiene() {
  if (!config.pack) return;
  if (!(await exists(join(repoRoot, "package.json")))) {
    warn("pack hygiene requested but no package.json found; skipping.");
    return;
  }

  const res = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status !== 0) {
    fail(`\`npm pack --dry-run\` failed: ${(res.stderr || res.stdout || "").trim().split("\n").pop()}`);
    return;
  }

  let meta;
  try {
    meta = JSON.parse(res.stdout)[0];
  } catch {
    fail("could not parse `npm pack --dry-run --json` output.");
    return;
  }

  const entries = (meta.files ?? []).map((f) => f.path.replaceAll("\\", "/").replace(/^\.\//, ""));
  const forbidden = [
    [/(^|\/)node_modules\//, "bundles node_modules"],
    [/(^|\/)\.env(\.|$)/, "leaks an environment file"],
    [/(^|\/)\.DS_Store$/, "includes macOS .DS_Store cruft"],
    [/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/, "ships a lockfile"],
    [/(^|\/)\.git(\/|$)/, "includes the git directory"],
    [/\.(pem|key|p12|keystore)$/, "includes a private key / credential file"],
    ...config.forbidInPack.map((p) => [new RegExp(p), `matches forbidden pattern /${p}/`]),
  ];
  for (const entry of entries) {
    for (const [re, why] of forbidden) {
      if (re.test(entry)) fail(`published tarball ${why}: ${entry}`);
    }
  }

  const size = meta.size ?? 0;
  assert(
    size <= config.maxPackBytes,
    `published tarball is ${kib(size)} which exceeds the ${kib(config.maxPackBytes)} budget. ` +
      `Add a "files" allowlist or .npmignore to trim it.`,
  );
}

// --- version source readers -------------------------------------------------

async function readVersionSource(source) {
  const path = join(repoRoot, sourcePath(source));
  if (!(await exists(path))) return null;
  const text = await readFile(path, "utf8");
  if (typeof source === "string" || source.json !== undefined) {
    const key = typeof source === "string" ? "version" : source.json;
    try {
      return key.split(".").reduce((o, k) => o?.[k], JSON.parse(text)) ?? null;
    } catch {
      return null;
    }
  }
  if (source.regex) {
    // The capture group (or the whole match) holds the version.
    const m = text.match(new RegExp(source.regex));
    return m ? (m[1] ?? m[0]) : null;
  }
  return null;
}

function sourcePath(s) {
  return typeof s === "string" ? s : s.path;
}

// --- helpers ----------------------------------------------------------------

function report() {
  if (warnings.length) {
    console.log("Warnings:");
    for (const w of warnings) console.log(`  - ${w}`);
    console.log("");
  }
  if (failures.length) {
    console.error(`Release readiness FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`Release readiness passed for v${version}.`);
}

function assert(cond, msg) {
  if (!cond) failures.push(msg);
}
function fail(msg) {
  failures.push(msg);
}
function warn(msg) {
  warnings.push(msg);
}
function isSemver(v) {
  return typeof v === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);
}
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function kib(n) {
  return `${(n / 1024).toFixed(1)} KiB`;
}
async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
async function readJsonOrNull(p) {
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    return null;
  }
}
