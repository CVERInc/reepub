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
await checkPrinciples();

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

// ---------------------------------------------------------------------------
// reepub-specific gates: the reverse constraints in PRINCIPLES.md.
//
// Each rule below is the machine-checkable half of a promise the README makes.
// They exist because every one of them was violated in a shipped version, and a
// promise that only a document asserts is one an audit finds, not CI.
// ---------------------------------------------------------------------------

async function checkPrinciples() {
  const PRINCIPLE_RULES = [
  {
    // PRINCIPLES.md §1 — Offline by architecture.
    principle: "§1 offline by architecture",
    why: "a listener on any other address puts the reader's books on the network",
    files: ["src/server.js"],
    pattern: /\.listen\s*\(/g,
    // The host may be written inline or held in a constant; either is fine as
    // long as the value it resolves to is loopback.
    accept: (line, source) => {
      const args = line.slice(line.indexOf(".listen(") + ".listen(".length);
      const second = args.split(",")[1];
      if (second === undefined) return false;
      const token = second.trim().replace(/[)'"`].*$/, "").trim();
      if (isLoopback(token)) return true;
      const binding = source.text.match(
        new RegExp(`\\b(?:const|let|var)\\s+${escapeRegex(token)}\\s*=\\s*['"\`]([^'"\`]+)`));
      return Boolean(binding && isLoopback(binding[1]));
    },
    message: "listen() without a host that resolves to 127.0.0.1",
  },
  {
    // PRINCIPLES.md §2 — Never ship an invalid book.
    principle: "§2 never ship an invalid book",
    why: "this is how a 45-error EPUB was written to disk with exit code 0",
    files: null,
    pattern: /\.catch\s*\(\s*console\.error\s*\)/g,
    message: "a pipeline ending in .catch(console.error), which logs a failure and exits 0",
  },
  {
    // PRINCIPLES.md §3 — One assembly path.
    principle: "§3 one assembly path",
    why: "three hand-rolled package templates drifted into three different bugs",
    files: null,
    exempt: ["src/binder.js"],
    // The macOS app is a standalone Swift build with no Node runtime, so it
    // necessarily carries its own writer. PRINCIPLES.md §6 governs that pair,
    // and scripts/check-sync-markers.mjs is what keeps them honest.
    extensions: [".js", ".mjs"],
    pattern: /<package[\s>]/g,
    message: "a <package> template outside src/binder.js",
  },
  {
    // PRINCIPLES.md §5 — Restraint. A shipped script had the maintainer's
    // iCloud path baked into it, so it only ever worked on one machine.
    principle: "§5 restraint",
    why: "a hardcoded personal path makes a tool that works on exactly one machine",
    files: null,
    pattern: /\/Users\/[A-Za-z0-9._-]+\/|Mobile Documents/g,
    message: "a hardcoded personal filesystem path",
  },
];

  const SOURCE_EXTENSIONS = [".js", ".mjs", ".swift"];
  // Scanned files are the ones git tracks: a release is made of what the
  // repository contains, not of whatever scratch scripts happen to sit in the
  // working tree. Test files quote the defects on purpose, and this checker has
  // to spell out the very patterns it forbids.
  const SELF = "scripts/check-release-readiness.mjs";
  const IS_TEST = /(^|\/)test-[^/]*\.(js|mjs)$/;

  const sources = [];
  for (const rel of trackedFiles()) {
    if (rel === SELF || IS_TEST.test(rel)) continue;
    if (!SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext))) continue;
    sources.push({ rel, text: await readFile(join(repoRoot, rel), "utf8") });
  }

  if (sources.length === 0) {
    warn("no tracked source files found to check PRINCIPLES.md against — is this a git repo root?");
    return;
  }

  for (const rule of PRINCIPLE_RULES) {
    const scope = sources
      .filter((s) => (rule.files ? rule.files.includes(s.rel) : !(rule.exempt || []).includes(s.rel)))
      .filter((s) => !rule.extensions || rule.extensions.some((ext) => s.rel.endsWith(ext)));

    for (const source of scope) {
      source.text.split("\n").forEach((line, i) => {
        // A line that only talks about the rule (a comment) is not a violation.
        if (/^\s*(\/\/|\*|#)/.test(line)) return;
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(line)) return;
        if (rule.accept && rule.accept(line, source)) return;
        fail(`PRINCIPLES.md ${rule.principle}: ${source.rel}:${i + 1} has ${rule.message} — ${rule.why}`);
      });
    }
  }

  if (!(await exists(join(repoRoot, "PRINCIPLES.md")))) {
    fail("PRINCIPLES.md is missing — the reverse constraints these gates enforce have to be written down");
  }
}

function isLoopback(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

// Tracked files plus new ones git would accept, minus anything .gitignore
// excludes. A file that is not committed yet is exactly where a fresh violation
// lives, so scanning only the index would let every new source file through.
function trackedFiles() {
  const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) return [];
  return [...new Set(result.stdout.split("\n").filter(Boolean))];
}

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
