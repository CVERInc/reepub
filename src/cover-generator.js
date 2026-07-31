const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function generateCover(title, author, outputPath) {
  // Split title if it's too long, though vertical text handles it well.
  // Use a classic, elegant vertical layout for Chinese books.
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body {
          margin: 0;
          padding: 0;
          width: 1600px;
          height: 2260px;
          background: linear-gradient(135deg, #1c2331 0%, #11151c 100%);
          color: #e0e0e0;
          font-family: "Songti SC", "STSong", "Kaiti TC", serif;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          box-sizing: border-box;
          position: relative;
        }
        .border {
          position: absolute;
          top: 80px;
          bottom: 80px;
          left: 80px;
          right: 80px;
          border: 2px solid rgba(255, 255, 255, 0.1);
          pointer-events: none;
        }
        .border-inner {
          position: absolute;
          top: 100px;
          bottom: 100px;
          left: 100px;
          right: 100px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          pointer-events: none;
        }
        .title {
          font-size: 200px;
          font-weight: normal;
          letter-spacing: 40px;
          writing-mode: vertical-rl;
          text-orientation: upright;
          text-shadow: 0 10px 30px rgba(0,0,0,0.5);
          height: 1400px;
          display: flex;
          align-items: center;
        }
        .author-container {
          position: absolute;
          bottom: 200px;
          left: 200px;
        }
        .author {
          font-size: 70px;
          letter-spacing: 20px;
          opacity: 0.6;
          writing-mode: vertical-rl;
          text-orientation: upright;
        }
        .publisher {
          position: absolute;
          bottom: 200px;
          right: 200px;
          font-size: 40px;
          font-family: "PingFang SC", sans-serif;
          letter-spacing: 15px;
          opacity: 0.3;
          writing-mode: vertical-rl;
          text-orientation: upright;
        }
      </style>
    </head>
    <body>
      <div class="border"></div>
      <div class="border-inner"></div>
      <div class="title">${title}</div>
      <div class="author-container">
        <div class="author">${author}</div>
      </div>
      <div class="publisher">REEPUB EDITIONS</div>
    </body>
    </html>
  `;

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1600, height: 2260 },
    deviceScaleFactor: 1
  });
  
  await page.setContent(html);
  // Wait a little bit for system fonts to render properly
  await page.waitForTimeout(500);
  
  await page.screenshot({ path: outputPath, type: 'jpeg', quality: 85 });
  await browser.close();
}

module.exports = { generateCover };
