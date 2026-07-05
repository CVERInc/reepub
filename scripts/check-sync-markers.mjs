#!/usr/bin/env node
// check-sync-markers.mjs — mechanical reminder that the Node and Swift EPUB
// builders are dual implementations that must be kept behaviorally in sync
// (see the "Kept behaviorally in sync with ..." comments at the top of each
// file). This does NOT check behavior, only that whoever last touched one
// side also bumped the shared `// sync-marker: vN` line on the other side.
//
// Exit 0 = markers match. Exit 1 = they don't (or one is missing) — bump all
// three to the same vN once you've confirmed the Node and Swift builders
// agree again.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'src/builder.js',
  'src/epub-text.js',
  'macos/Sources/ReepubCore/EpubBuilder.swift',
];

const MARKER_RE = /sync-marker:\s*(\S+)/;

async function readMarker(relPath) {
  const text = await readFile(join(repoRoot, relPath), 'utf8');
  const match = text.split('\n', 20).join('\n').match(MARKER_RE);
  if (!match) {
    throw new Error(`${relPath}: missing "// sync-marker: vN" line near the top of the file`);
  }
  return match[1];
}

const markers = await Promise.all(FILES.map(readMarker));

const distinct = new Set(markers);
if (distinct.size > 1) {
  console.error('✗ sync-marker mismatch across the dual EPUB-builder implementations:');
  FILES.forEach((f, i) => console.error(`    ${markers[i]}  ${f}`));
  console.error('  Bump all three to the same vN once Node and Swift are confirmed in sync again.');
  process.exit(1);
}

console.log(`✓ sync-marker ${markers[0]} matches across: ${FILES.join(', ')}`);
