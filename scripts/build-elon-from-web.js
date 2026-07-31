const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const { generateCover } = require('../src/cover-generator');
const { validateEpub } = require('../src/validator');

async function optimizeImage(srcPath, destPath) {
  const ext = path.extname(srcPath).toLowerCase();
  try {
    let pipeline = sharp(srcPath);
    const metadata = await pipeline.metadata();
    
    // Dehydrator: Resize and Compress
    if (metadata.width > 1600 || metadata.height > 1600) {
      pipeline = pipeline.resize(1600, 1600, { fit: 'inside', withoutEnlargement: true });
    }
    
    if (ext === '.png') {
      pipeline = pipeline.png({ palette: true, quality: 80, colors: 256 });
    } else if (ext === '.jpg' || ext === '.jpeg') {
      pipeline = pipeline.jpeg({ quality: 80 });
    }
    
    await pipeline.toFile(destPath);
  } catch (err) {
    console.error(`Failed to optimize ${srcPath}:`, err.message);
    fs.copyFileSync(srcPath, destPath); // fallback
  }
}

async function buildFromWeb() {
  const srcDir = '/tmp/book-of-elon-src';
  const outEpub = path.resolve('/Users/chodaict/Library/Mobile Documents/com~apple~CloudDocs/@MixFlavor/epub/from Scan/The Book of Elon (Built from Web).epub');
  
  if (!fs.existsSync(srcDir)) {
    throw new Error('Source directory not found. Please clone the repo first.');
  }

  const tmp = `/tmp/reepub-build-${Date.now()}`;
  const oebps = path.join(tmp, 'OEBPS');
  const meta = path.join(tmp, 'META-INF');
  fs.mkdirSync(oebps, { recursive: true });
  fs.mkdirSync(path.join(oebps, 'images'), { recursive: true });
  fs.mkdirSync(meta, { recursive: true });

  // 1. Initial Setup
  fs.writeFileSync(path.join(tmp, 'mimetype'), 'application/epub+zip');
  fs.writeFileSync(path.join(meta, 'container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);

  // 2. Dehydrator (Images)
  console.log('Dehydrating images...');
  const srcImages = fs.readdirSync(path.join(srcDir, 'images'));
  for (const img of srcImages) {
    if (img.match(/\.(png|jpe?g)$/i)) {
      await optimizeImage(path.join(srcDir, 'images', img), path.join(oebps, 'images', img));
    }
  }

  // 3. Sanitizer (HTML)
  console.log('Sanitizing HTML...');
  const chaptersDir = path.join(srcDir, 'chapters');
  const chapterFiles = fs.readdirSync(chaptersDir).filter(f => f.match(/^ch\d+\.html$/)).sort();
  
  const allChapters = [];
  
  for (let i = 0; i < chapterFiles.length; i++) {
    const rawHtml = fs.readFileSync(path.join(chaptersDir, chapterFiles[i]), 'utf8');
    
    // Extract content (between hero and bottom nav)
    const contentMatch = rawHtml.match(/<div class="ch-hero">([\s\S]*?)<!-- ═══ 導航 ═══ -->/);
    if (!contentMatch) continue;
    
    let body = '<div class="ch-hero">' + contentMatch[1] + '</div>'; // close container
    
    // Sanitize!
    body = body.replace(/<br>/g, '<br/>'); // Fix empty tags
    body = body.replace(/<hr>/g, '<hr/>');
    body = body.replace(/<img([^>]+[^\/])>/g, '<img$1/>'); // Auto-close images
    body = body.replace(/&(?!#?[a-zA-Z0-9]+;)/g, '&amp;'); // Fix ampersands
    body = body.replace(/\.\.\/images\//g, 'images/'); // Fix paths
    
    // Extract Title for TOC
    const titleMatch = body.match(/<h1>(.*?)<\/h1>/);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '') : `Chapter ${i + 1}`;
    
    // Wrap in standard XHTML
    const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW">
<head><title>${title}</title></head>
<body>
${body}
</body>
</html>`;
    
    const fileName = `${i + 1}.xhtml`;
    fs.writeFileSync(path.join(oebps, fileName), xhtml);
    allChapters.push({ id: `P${i + 1}`, href: fileName, title });
  }

  // 4. Binder (Cover & Meta)
  console.log('Generating Cover & Binding...');
  const coverImgPath = path.join(oebps, 'images', 'cover.jpeg');
  await generateCover('The Book of Elon', 'Eugene (Translator)', coverImgPath, 'horizontal');
  
  const coverXhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW">
<head><title>Cover</title></head>
<body>
  <div style="text-align: center; page-break-after: always; break-after: page; width: 100%; margin: 0; padding: 0;">
    <img src="images/cover.jpeg" alt="Cover" style="width: 100%; height: auto; display: block; margin: 0 auto;" />
  </div>
</body>
</html>`;
  fs.writeFileSync(path.join(oebps, 'cover.xhtml'), coverXhtml);
  
  // Create OPF
  const opfItems = [
    '    <item id="cover-image" href="images/cover.jpeg" media-type="image/jpeg"/>',
    '    <item id="cover-xhtml" href="cover.xhtml" media-type="application/xhtml+xml"/>'
  ];
  const opfSpine = ['    <itemref idref="cover-xhtml"/>'];
  const ncxNav = [];
  
  allChapters.forEach((ch, idx) => {
    opfItems.push(`    <item id="${ch.id}" href="${ch.href}" media-type="application/xhtml+xml"/>`);
    opfSpine.push(`    <itemref idref="${ch.id}"/>`);
    ncxNav.push(`    <navPoint id="navPoint-${idx+1}" playOrder="${idx+1}">
      <navLabel><text>${ch.title}</text></navLabel>
      <content src="${ch.href}"/>
    </navPoint>`);
  });
  
  // Add image manifest items
  const finalImages = fs.readdirSync(path.join(oebps, 'images'));
  finalImages.forEach(img => {
    if (img === 'cover.jpeg') return;
    const mt = img.endsWith('.png') ? 'image/png' : 'image/jpeg';
    opfItems.push(`    <item id="img-${img.replace(/[^a-zA-Z0-9]/g, '')}" href="images/${img}" media-type="${mt}"/>`);
  });
  
  opfItems.push('    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="BookID" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Book of Elon</dc:title>
    <dc:creator>Eugene</dc:creator>
    <dc:language>zh-TW</dc:language>
    <dc:identifier id="BookID">urn:uuid:book-of-elon-web</dc:identifier>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>\n${opfItems.join('\n')}\n  </manifest>
  <spine toc="ncx">\n${opfSpine.join('\n')}\n  </spine>
</package>`;
  fs.writeFileSync(path.join(oebps, 'content.opf'), opf);
  
  // Create NCX
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="urn:uuid:book-of-elon-web"/></head>
  <docTitle><text>The Book of Elon</text></docTitle>
  <navMap>\n${ncxNav.join('\n')}\n  </navMap>
</ncx>`;
  fs.writeFileSync(path.join(oebps, 'toc.ncx'), ncx);

  // 5. Repackage
  console.log('Packaging EPUB...');
  if (fs.existsSync(outEpub)) fs.unlinkSync(outEpub);
  execFileSync('zip', ['-0Xq', outEpub, 'mimetype'], { cwd: tmp });
  execFileSync('zip', ['-ur9q', outEpub, 'META-INF', 'OEBPS'], { cwd: tmp });
  
  const sizeMb = (fs.statSync(outEpub).size / 1024 / 1024).toFixed(2);
  console.log(`Success! Saved to ${path.basename(outEpub)} (${sizeMb} MB)`);
  
  console.log('Validating...');
  const val = validateEpub(outEpub);
  if (!val.success) {
    console.error('Validation failed:\n' + val.error);
  } else {
    console.log('✓ EPUB valid');
  }
  
  fs.rmSync(tmp, { recursive: true, force: true });
}

buildFromWeb().catch(console.error);
