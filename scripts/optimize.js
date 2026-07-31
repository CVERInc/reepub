const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const { validateEpub } = require('../src/validator');

async function optimizeImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const tmpPath = filePath + '.tmp';
  
  try {
    const image = sharp(filePath);
    const metadata = await image.metadata();
    
    let pipeline = image;
    let needsOptimization = false;
    
    // 1. Resize if too large
    if (metadata.width > 1600 || metadata.height > 1600) {
      pipeline = pipeline.resize(1600, 1600, { fit: 'inside', withoutEnlargement: true });
      needsOptimization = true;
    }
    
    // 2. Compress format
    if (ext === '.png') {
      // 8-bit quantized PNG for charts/diagrams
      pipeline = pipeline.png({ palette: true, quality: 80, colors: 256 });
      needsOptimization = true;
    } else if (ext === '.jpg' || ext === '.jpeg') {
      // 80% JPEG
      pipeline = pipeline.jpeg({ quality: 80 });
      needsOptimization = true;
    }
    
    if (needsOptimization) {
      const originalSize = fs.statSync(filePath).size;
      await pipeline.toFile(tmpPath);
      const newSize = fs.statSync(tmpPath).size;
      
      // Only keep if it actually saved space
      if (newSize < originalSize) {
        fs.renameSync(tmpPath, filePath);
        return { originalSize, newSize };
      } else {
        fs.unlinkSync(tmpPath);
      }
    }
  } catch (err) {
    console.error(`Error optimizing ${filePath}:`, err.message);
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log('Usage: node scripts/optimize.js <input.epub> <output.epub>');
    process.exit(1);
  }
  
  const inputEpub = path.resolve(args[0]);
  const outputEpub = path.resolve(args[1]);
  
  const tmp = path.join(path.dirname(outputEpub), `.reepub-opt-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  
  console.log(`Unzipping ${path.basename(inputEpub)}...`);
  execFileSync('unzip', ['-q', inputEpub, '-d', tmp]);
  
  // Find images dir
  const oebpsDir = path.join(tmp, 'OEBPS');
  const imagesDir = path.join(oebpsDir, 'images');
  
  if (fs.existsSync(imagesDir)) {
    const files = fs.readdirSync(imagesDir);
    let totalSaved = 0;
    
    for (const f of files) {
      if (f.match(/\.(png|jpe?g)$/i)) {
        process.stdout.write(`Optimizing ${f}... `);
        const imgPath = path.join(imagesDir, f);
        const result = await optimizeImage(imgPath);
        
        if (result) {
          const saved = result.originalSize - result.newSize;
          totalSaved += saved;
          console.log(`saved ${(saved / 1024 / 1024).toFixed(2)} MB`);
        } else {
          console.log('skipped');
        }
      }
    }
    console.log(`\nTotal space saved: ${(totalSaved / 1024 / 1024).toFixed(2)} MB`);
  }
  
  console.log('Repackaging...');
  if (fs.existsSync(outputEpub)) fs.unlinkSync(outputEpub);
  execFileSync('zip', ['-0Xq', outputEpub, 'mimetype'], { cwd: tmp });
  execFileSync('zip', ['-ur9q', outputEpub, 'META-INF', 'OEBPS'], { cwd: tmp });
  
  const sizeMb = (fs.statSync(outputEpub).size / 1024 / 1024).toFixed(2);
  console.log(`Saved optimized EPUB: ${path.basename(outputEpub)} (${sizeMb} MB)`);
  
  console.log('Validating...');
  const val = validateEpub(outputEpub);
  if (!val.success) {
    console.error('Validation failed:\n' + val.error);
  } else {
    console.log('✓ EPUB valid');
  }
  
  fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch(console.error);
