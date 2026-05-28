const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const { validateEpub } = require('./validator');

// CLI Arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node src/builder.js <input.pdf> <output.epub> [book-title] [book-author]');
  process.exit(1);
}

const pdfPath = path.resolve(args[0]);
const epubPath = path.resolve(args[1]);
const bookTitle = args[2] || path.basename(pdfPath, path.extname(pdfPath));
const bookAuthor = args[3] || 'Unknown Author';

const PROJECT_DIR = path.resolve(__dirname, '..');
const TEMP_DIR = path.join(PROJECT_DIR, 'temp-epub-ocr');
const OEBPS_DIR = path.join(TEMP_DIR, 'OEBPS');
const CHAPTERS_DIR = path.join(OEBPS_DIR, 'chapters');
const IMAGES_DIR = path.join(OEBPS_DIR, 'images');

console.log(`Target PDF: ${pdfPath}`);
console.log(`Output EPUB: ${epubPath}`);
console.log(`Book Title: ${bookTitle}`);
console.log(`Author: ${bookAuthor}`);

// 1. Set up temp directory
if (fs.existsSync(TEMP_DIR)) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}
fs.mkdirSync(TEMP_DIR);
fs.mkdirSync(path.join(TEMP_DIR, 'META-INF'));
fs.mkdirSync(OEBPS_DIR);
fs.mkdirSync(CHAPTERS_DIR);
fs.mkdirSync(IMAGES_DIR);

// 2. Create mimetype
fs.writeFileSync(path.join(TEMP_DIR, 'mimetype'), 'application/epub+zip', 'utf8');

// 3. Create container.xml
const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
fs.writeFileSync(path.join(TEMP_DIR, 'META-INF', 'container.xml'), containerXml, 'utf8');

// 4. Run Swift OCR CLI and extract cover image
console.log('\n--- Step 1: Performing Native macOS OCR (Vision API) ---');
const binOcr = path.join(PROJECT_DIR, 'bin', 'scan-ocr');
if (!fs.existsSync(binOcr)) {
  console.error(`Error: Native binary scan-ocr not found at ${binOcr}. Please run 'make build' first.`);
  process.exit(1);
}

const coverFile = path.join(IMAGES_DIR, 'cover.jpeg');
let ocrPages = [];
try {
  // Pass input PDF and cover image path
  const stdout = execFileSync(binOcr, [pdfPath, coverFile], {
    maxBuffer: 1024 * 1024 * 50 // 50MB buffer to prevent overflow
  });
  ocrPages = JSON.parse(stdout.toString());
} catch (error) {
  console.error('OCR Extraction failed:', error);
  process.exit(1);
}

console.log('\n--- Step 2: Processing OCR Layout and Reconstructing Text ---');

// Smart string joiner for Chinese/English text
function joinText(lines) {
  let result = '';
  for (let j = 0; j < lines.length; j++) {
    const text = lines[j].text.trim();
    if (result === '') {
      result = text;
      continue;
    }
    
    const lastChar = result.slice(-1);
    const firstChar = text.charAt(0);
    
    // Add space if joining two alphanumeric/Latin words
    const lastIsLatin = /[a-zA-Z0-9]/.test(lastChar);
    const firstIsLatin = /[a-zA-Z0-9]/.test(firstChar);
    
    if (lastIsLatin && firstIsLatin) {
      result += ' ' + text;
    } else {
      result += text; // Chinese has no spaces
    }
  }
  return result;
}

// Process single page into paragraphs
function processPage(page) {
  const lines = page.lines;
  if (!lines || lines.length === 0) return [];
  
  // Filter out headers (top-most) and footers (bottom-most)
  const filteredLines = lines.filter(line => {
    // y-up normalized coordinates (0 = bottom, 1 = top)
    if (line.y > 0.94) return false; // top header
    if (line.y < 0.06) return false; // bottom footer/page number
    return true;
  });
  
  if (filteredLines.length === 0) return [];
  
  const avgHeight = filteredLines.reduce((sum, l) => sum + l.height, 0) / filteredLines.length;
  
  const paragraphs = [];
  let currentParaLines = [];
  
  for (let j = 0; j < filteredLines.length; j++) {
    const line = filteredLines[j];
    if (currentParaLines.length === 0) {
      currentParaLines.push(line);
      continue;
    }
    
    const prevLine = currentParaLines[currentParaLines.length - 1];
    const gap = prevLine.y - (line.y + line.height);
    
    let isBreak = false;
    
    if (gap > avgHeight * 1.8) {
      isBreak = true;
    } else if (/[。！？?！」「””\.\!\?]$/.test(prevLine.text.trim()) && gap > avgHeight * 0.95) {
      isBreak = true;
    } else if (line.x - prevLine.x > 0.05) {
      isBreak = true;
    } else if (prevLine.height > avgHeight * 1.45 || line.height > avgHeight * 1.45) {
      isBreak = true;
    }
    
    if (isBreak) {
      paragraphs.push(currentParaLines);
      currentParaLines = [line];
    } else {
      currentParaLines.push(line);
    }
  }
  if (currentParaLines.length > 0) {
    paragraphs.push(currentParaLines);
  }
  
  return paragraphs.map(pLines => {
    const text = joinText(pLines);
    // Heading heuristic: short length & large font height
    const isHeading = pLines.length === 1 && pLines[0].height > avgHeight * 1.35 && text.length < 40;
    return { text, isHeading };
  });
}

// 5. Structure into chapters (incorporating hybrid text and image pages)
const chapters = [];
let currentChapter = {
  type: 'text',
  title: '前言 / 開始閱讀',
  paragraphs: [],
  pageIndexStart: 0
};

ocrPages.forEach((page, idx) => {
  if (page.type === 'image') {
    // If it's the first page (cover), we skip it to avoid duplication with cover.xhtml
    if (idx === 0) return;
    
    // For subsequent image pages, flush current text chapter first
    if (currentChapter.paragraphs.length > 0) {
      chapters.push(currentChapter);
    }
    
    // Insert a dedicated image chapter
    chapters.push({
      type: 'image',
      title: `插圖 (頁 ${idx + 1})`,
      imagePath: page.imagePath,
      pageIndexStart: idx
    });
    
    // Reset currentChapter
    currentChapter = {
      type: 'text',
      title: `第 ${chapters.length + 1} 部分 (頁 ${idx + 1})`,
      paragraphs: [],
      pageIndexStart: idx + 1
    };
    return;
  }
  
  // Process normal text page
  const pageParas = processPage(page);
  pageParas.forEach(p => {
    const isChStart = p.isHeading && (
      p.text.includes('章') || 
      p.text.toLowerCase().includes('chapter') || 
      p.text.includes('第一') || p.text.includes('第二') || p.text.includes('第三') ||
      p.text.includes('第四') || p.text.includes('第五') || p.text.includes('第六')
    );
    
    if (isChStart && currentChapter.paragraphs.length > 0) {
      chapters.push(currentChapter);
      currentChapter = {
        type: 'text',
        title: p.text,
        paragraphs: [],
        pageIndexStart: idx
      };
    } else if (currentChapter.paragraphs.length > 90) {
      chapters.push(currentChapter);
      currentChapter = {
        type: 'text',
        title: `第 ${chapters.length + 1} 部分 (頁 ${idx + 1})`,
        paragraphs: [],
        pageIndexStart: idx
      };
    }
    currentChapter.paragraphs.push(p);
  });
});

if (currentChapter.paragraphs.length > 0) {
  chapters.push(currentChapter);
}

console.log(`Reconstructed ${chapters.length} chapters/sections from ${ocrPages.length} PDF pages.`);

// 6. Write style.css
const styleCss = `/* Stylesheet for scanned EPUB */
body {
  font-family: serif;
  line-height: 1.6;
  margin: 0;
  padding: 10px;
}
h1, h2, h3 {
  font-family: sans-serif;
  text-align: center;
  margin-top: 1.2em;
  margin-bottom: 0.6em;
}
h2 {
  font-size: 1.4em;
  border-bottom: 1px solid #e2e8f0;
  padding-bottom: 5px;
}
p {
  margin-bottom: 1.2em;
  text-indent: 2em; /* Chinese paragraph indentation */
}
p.heading-p {
  text-indent: 0;
  text-align: center;
  font-weight: bold;
}
img.cover {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0 auto;
}
`;
fs.writeFileSync(path.join(OEBPS_DIR, 'style.css'), styleCss, 'utf8');



// 7. Write XHTML chapters (with hybrid support for text and image pages)
const manifestChapters = [];
chapters.forEach((ch, idx) => {
  const pad = String(idx + 1).padStart(2, '0');
  const fileName = `ch${pad}.xhtml`;
  let xhtml = '';
  
  if (ch.type === 'image') {
    // For image pages, use highly compatible OEB margin-reset inline CSS to bypass Kindle default margins without using SVG
    xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>${ch.title}</title>
</head>
<body style="margin: 0; padding: 0; text-align: center; background-color: #ffffff; oeb-page-head-margin: 0 !important; oeb-page-foot-margin: 0 !important; oeb-page-left-margin: 0 !important; oeb-page-right-margin: 0 !important;">
  <div class="cover-container" style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
    <img class="cover-image" src="../${ch.imagePath}" alt="${ch.title}" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
  </div>
</body>
</html>`;
  } else {
    // For standard text chapters
    const bodyContent = ch.paragraphs.map(p => {
      const textEscaped = p.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
        
      if (p.isHeading) {
        return `  <h2>${textEscaped}</h2>`;
      }
      return `  <p>${textEscaped}</p>`;
    }).join('\n');
    
    xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>${ch.title}</title>
  <link rel="stylesheet" href="../style.css" type="text/css" />
</head>
<body>
  <h1>${ch.title}</h1>
  <hr />
${bodyContent}
</body>
</html>`;
  }

  fs.writeFileSync(path.join(CHAPTERS_DIR, fileName), xhtml, 'utf8');
  manifestChapters.push({
    id: `ch${pad}`,
    title: ch.title,
    href: `chapters/${fileName}`
  });
});

// 8. Write cover.xhtml (using OEB margin-reset template to bypass Kindle margins and prevent crashes)
const isCoverExist = fs.existsSync(coverFile);
const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>Cover</title>
</head>
<body style="margin: 0; padding: 0; text-align: center; background-color: #ffffff; oeb-page-head-margin: 0 !important; oeb-page-foot-margin: 0 !important; oeb-page-left-margin: 0 !important; oeb-page-right-margin: 0 !important;">
  <div class="cover-container" style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
    <img class="cover-image" src="images/cover.jpeg" alt="${bookTitle}" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
  </div>
</body>
</html>`;
fs.writeFileSync(path.join(OEBPS_DIR, 'cover.xhtml'), coverXhtml, 'utf8');

// 9. Write index.xhtml (TOC page)
const tocItems = manifestChapters.map(ch => {
  return `    <li><a href="${ch.href}">${ch.title}</a></li>`;
}).join('\n');

const indexXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-Hant" lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <title>${bookTitle} - 目錄</title>
  <link rel="stylesheet" href="style.css" type="text/css" />
</head>
<body>
  <h1>目錄</h1>
  <hr />
  <ul>
${tocItems}
  </ul>
</body>
</html>`;
fs.writeFileSync(path.join(OEBPS_DIR, 'index.xhtml'), indexXhtml, 'utf8');

// 10. Write content.opf
const chapterManifest = manifestChapters.map(ch => {
  return `    <item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`;
}).join('\n');

const spineRefs = manifestChapters.map(ch => {
  return `    <itemref idref="${ch.id}"/>`;
}).join('\n');

const imageItems = [];
chapters.forEach((ch, idx) => {
  if (ch.type === 'image' && ch.imagePath) {
    const imgId = `page-img-${idx + 1}`;
    imageItems.push(`    <item id="${imgId}" href="${ch.imagePath}" media-type="image/jpeg"/>`);
  }
});
const imageManifest = imageItems.join('\n');

// isCoverExist is already defined above
let coverManifest = '';
let coverRef = '';
if (isCoverExist) {
  coverManifest = `    <item id="cover-image" href="images/cover.jpeg" media-type="image/jpeg"/>\n    <item id="cover-xhtml" href="cover.xhtml" media-type="application/xhtml+xml"/>`;
  coverRef = `    <itemref idref="cover-xhtml"/>`;
}

const contentOpf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${bookTitle.replace(/&/g, '&amp;')}</dc:title>
    <dc:creator>${bookAuthor.replace(/&/g, '&amp;')}</dc:creator>
    <dc:language>zh-Hant</dc:language>
    <dc:identifier id="BookID">urn:uuid:ocr-book-${Date.now()}</dc:identifier>
    <meta property="dcterms:modified">${new Date().toISOString().substring(0, 19) + 'Z'}</meta>
    ${isCoverExist ? '<meta name="cover" content="cover-image"/>' : ''}
  </metadata>
  <manifest>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="index" href="index.xhtml" media-type="application/xhtml+xml"/>
${coverManifest}
${imageManifest}
${chapterManifest}
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
${coverRef}
    <itemref idref="index"/>
${spineRefs}
  </spine>
</package>`;
fs.writeFileSync(path.join(OEBPS_DIR, 'content.opf'), contentOpf, 'utf8');

// 11. Write toc.ncx
const tocNavPoints = manifestChapters.map((ch, idx) => {
  return `    <navPoint id="navPoint-${ch.id}" playOrder="${idx + 2}">
      <navLabel><text>${ch.title}</text></navLabel>
      <content src="${ch.href}"/>
    </navPoint>`;
}).join('\n');

const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="urn:uuid:ocr-book-${Date.now()}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${bookTitle}</text>
  </docTitle>
  <navMap>
    <navPoint id="navPoint-index" playOrder="1">
      <navLabel><text>目錄</text></navLabel>
      <content src="index.xhtml"/>
    </navPoint>
${tocNavPoints}
  </navMap>
</ncx>`;
fs.writeFileSync(path.join(OEBPS_DIR, 'toc.ncx'), tocNcx, 'utf8');

console.log('\n--- Step 3: Packaging to EPUB Archive ---');
try {
  if (fs.existsSync(epubPath)) {
    fs.unlinkSync(epubPath);
  }
  
  // Package with zip command line
  execFileSync('zip', ['-0Xq', epubPath, 'mimetype'], { cwd: TEMP_DIR });
  execFileSync('zip', ['-ur9q', epubPath, 'META-INF', 'OEBPS'], { cwd: TEMP_DIR });
  
  console.log(`\nEPUB successfully generated: ${epubPath}`);
} catch (error) {
  console.error('Packaging failed:', error);
  process.exit(1);
}

console.log('\n--- Step 4: Automating XML and Manifest Verification (EPUBCheck) ---');
const validationResult = validateEpub(epubPath);

// Clean up temp dir
if (fs.existsSync(TEMP_DIR)) {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
}

if (!validationResult.success) {
  console.error(`\n[Failure] EPUB validation failed:\n${validationResult.error}`);
  if (fs.existsSync(epubPath)) {
    fs.unlinkSync(epubPath);
  }
  process.exit(1);
}

console.log('\n[Success] EPUB validation passed! The generated EPUB has no XML or manifest errors.');
