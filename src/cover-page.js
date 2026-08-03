'use strict';

// The cover as text — the parts that need no browser.
//
// cover-generator.js draws a cover, which means Chromium and sharp, ~150MB of
// install. But two of the things callers want from it are pure string work:
// deciding which layout an edition gets, and writing the XHTML page that shows
// the finished image. merge.js needs the second one for every book that HAS a
// cover, including one it merely carried across rather than redrew — so asking
// for it used to drag a browser into the dependency budget of a package whose
// entire pitch is that it validates and repairs EPUBs with one library.
//
// A lazy require would not have helped: the cost is charged at install time,
// not at load time, so the fix has to be a boundary rather than a delay.
//
// This is also the first cut along the seam the cover migration needs anyway —
// typeset once, rasterise twice (Chromium for the command line, WKWebView for
// the app). Typesetting is the part that must not exist in two places.

const { escapeXML, escapeAttr } = require('./epub-text');

// The grey a reader pads a cover with, measured off the device rather than
// chosen: a cover of any proportion bleeds into that padding instead of meeting
// it with a seam. Deliberately not pure black — pure black is what left one.
const COVER_GROUND = '#111111';

/**
 * Which cover an edition gets.
 *
 * A right-to-left spine means a vertical cover; everything else gets the
 * horizontal one. The rule lives here, once, because it is a property of the
 * edition: callers that each re-derive it from their own idea of "is this a
 * Chinese book" are how two books in one series end up with two different
 * covers.
 */
function layoutForDirection(pageDirection) {
  return String(pageDirection || '').toLowerCase() === 'rtl' ? 'vertical' : 'horizontal';
}

/**
 * The page that shows the cover image.
 *
 * One picture, two jobs: the raster the shelf shows is also the page the reader
 * opens. Setting the type again here as live HTML would look better in
 * principle and worse in fact — a reader that converts EPUB to its own format
 * supports far less CSS than the browser the raster was drawn in, so the page
 * could break while the thumbnail beside it stayed perfect.
 */
function buildCoverImagePage({ imageHref, title = '', language = 'en' } = {}) {
  const lang = escapeAttr(language || 'en');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXML(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; background: ${COVER_GROUND}; }
    body { text-align: center; page-break-after: always; break-after: page; }
    img { width: 100%; height: auto; display: block; margin: 0 auto; }
  </style>
</head>
<body epub:type="cover">
  <img src="${escapeAttr(imageHref)}" alt="${escapeAttr(title)}" />
</body>
</html>`;
}

module.exports = { COVER_GROUND, layoutForDirection, buildCoverImagePage };
