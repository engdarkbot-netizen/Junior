import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const HTML_FILE = resolve('./index.html');

(async () => {
  console.log('Launching browser...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to Netlify Drop...');
  await page.goto('https://app.netlify.com/drop', { waitUntil: 'networkidle', timeout: 30000 });

  console.log('Page title:', await page.title());

  // Look for the file input on the drop zone
  const fileInput = await page.$('input[type="file"]');
  if (fileInput) {
    console.log('Found file input — uploading...');
    await fileInput.setInputFiles(HTML_FILE);
  } else {
    // Try triggering the drop zone via JavaScript
    console.log('No file input found directly, trying drop zone...');
    await page.screenshot({ path: '/tmp/netlify-before.png' });
    console.log('Screenshot saved to /tmp/netlify-before.png');

    // Some drop zones reveal a hidden input after interaction
    await page.evaluate(() => {
      const inputs = document.querySelectorAll('input[type="file"]');
      inputs.forEach(i => {
        i.style.display = 'block';
        i.style.opacity = '1';
        i.style.visibility = 'visible';
      });
    });

    const revealedInput = await page.$('input[type="file"]');
    if (revealedInput) {
      await revealedInput.setInputFiles(HTML_FILE);
    }
  }

  console.log('Waiting for upload to complete...');

  // Wait for a URL to appear in the page
  try {
    await page.waitForFunction(() => {
      const text = document.body.innerText;
      return text.includes('.netlify.app') || text.includes('Your site is live');
    }, { timeout: 60000 });

    const content = await page.evaluate(() => document.body.innerText);
    const match = content.match(/https:\/\/[\w-]+\.netlify\.app/);
    if (match) {
      console.log('\n✅ LIVE URL:', match[0]);
    } else {
      console.log('Upload may have succeeded. Page text snippet:', content.slice(0, 500));
    }
  } catch (e) {
    console.log('Timed out waiting for URL. Taking screenshot...');
    await page.screenshot({ path: '/tmp/netlify-after.png' });
    console.log('Screenshot: /tmp/netlify-after.png');
    const content = await page.evaluate(() => document.body.innerText);
    console.log('Page text:', content.slice(0, 800));
  }

  await browser.close();
})();
