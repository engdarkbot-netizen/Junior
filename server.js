/**
 * GroceryCompare SA — Real-time Price Scraper Server
 *
 * Run locally:  node server.js
 * Production:   Deploy via Docker (Railway / Render)
 *
 * Environment variables:
 *   PORT          - HTTP port (default 3000)
 *   PROXY_URL     - Residential proxy e.g. http://host:port
 *                   (Bright Data / Oxylabs — use a Saudi exit node)
 *   PROXY_USER    - Proxy username
 *   PROXY_PASS    - Proxy password
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { chromium } = require('playwright');

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── Proxy config (optional) ──────────────────────────────────── */
const PROXY_URL  = process.env.PROXY_URL  || null;
const PROXY_USER = process.env.PROXY_USER || null;
const PROXY_PASS = process.env.PROXY_PASS || null;

app.use(cors());
app.use(express.static(path.join(__dirname)));

/* ─── Browser pool ─────────────────────────────────────────────── */
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    browserInstance = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
    });
  }
  return browserInstance;
}

async function newPage(browser) {
  const contextOptions = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'ar-SA',                     // appear as Saudi visitor
    timezoneId: 'Asia/Riyadh',
    extraHTTPHeaders: {
      'Accept-Language': 'ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    },
  };

  // Route through Saudi residential proxy when configured
  if (PROXY_URL) {
    contextOptions.proxy = {
      server:   PROXY_URL,
      username: PROXY_USER || undefined,
      password: PROXY_PASS || undefined,
    };
  }

  const ctx = await browser.newContext(contextOptions);

  // Mask Playwright fingerprint
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'language',  { get: () => 'ar-SA' });
    Object.defineProperty(navigator, 'languages', { get: () => ['ar-SA', 'ar', 'en-US'] });
  });

  return ctx.newPage();
}

/* ─── Generic price extractor ──────────────────────────────────── */
/**
 * Given a loaded Playwright page, try multiple strategies to extract
 * product results: [{ name, price, image, url }]
 */
async function extractProducts(page, storeName) {
  return page.evaluate((store) => {
    const results = [];

    /* 1. JSON-LD structured data (schema.org/Product) */
    document.querySelectorAll('script[type="application/ld+json"]').forEach(el => {
      try {
        const data = JSON.parse(el.textContent);
        const items = Array.isArray(data) ? data : [data];
        items.forEach(item => {
          if (item['@type'] === 'Product' && item.offers) {
            const price = parseFloat(
              item.offers.price || item.offers.lowPrice || 0
            );
            if (price > 0) {
              results.push({
                name:  item.name  || '',
                price: price,
                image: item.image  || '',
                url:   item.offers.url || window.location.href,
              });
            }
          }
        });
      } catch (_) {}
    });

    if (results.length >= 3) return results.slice(0, 10);

    /* 2. Common CSS selector patterns used by major e-commerce platforms */
    const SELECTORS = {
      containers: [
        // Generic
        '[data-testid*="product"]',
        '[data-qa*="product"]',
        '[data-component*="product"]',
        // Salla platform (Panda, others)
        '.salla-product-card',
        'salla-product-card',
        // Noon
        '[class*="productContainer"]',
        '[class*="product-container"]',
        '[class*="productBox"]',
        // Magento (LuLu, Othaim)
        '.product-item',
        '.product-card',
        'li.product',
        '.item.product',
        // SAP Spartacus (Carrefour)
        'cx-product-grid-item',
        'cx-product-list-item',
        // Shopify
        '.product-item',
        '[class*="ProductItem"]',
        // Danube / Bin Dawood
        '.product',
        '[class*="product_card"]',
        '[class*="ProductCard"]',
      ],
      names: [
        '[data-qa*="name"]', '[data-testid*="name"]',
        '[class*="product-name"]', '[class*="productName"]',
        '[class*="ProductName"]', '[class*="product_name"]',
        '[class*="product-title"]', '[class*="productTitle"]',
        '.product-title', '.product-name', 'h2.name', 'h3.name',
        '.item-name', '.title', 'a[title]',
        'salla-product-card [slot="title"]',
      ],
      prices: [
        '[data-qa*="price"]', '[data-testid*="price"]',
        '[class*="product-price"]', '[class*="productPrice"]',
        '[class*="ProductPrice"]', '[class*="product_price"]',
        '[class*="price--sale"]', '[class*="price__sale"]',
        '[class*="priceText"]', '[class*="price-text"]',
        '.price', '.price__current', '.price-box',
        '[class*="finalPrice"]', '[class*="final-price"]',
        'salla-product-card [slot="price"]',
        'salla-price',
      ],
    };

    // Try each container selector
    for (const sel of SELECTORS.containers) {
      const containers = [...document.querySelectorAll(sel)];
      if (containers.length < 2) continue;

      for (const container of containers.slice(0, 10)) {
        let name  = '';
        let price = 0;
        let image = '';
        let url   = '';

        // Extract name
        for (const ns of SELECTORS.names) {
          const el = container.querySelector(ns);
          if (el) { name = (el.getAttribute('title') || el.textContent || '').trim(); break; }
        }

        // Extract price — try selectors first
        for (const ps of SELECTORS.prices) {
          const el = container.querySelector(ps);
          if (el) {
            const txt = el.textContent.replace(/[^\d.٫٬]/g, '').replace('٫', '.').replace('٬', '');
            const n = parseFloat(txt);
            if (n > 0) { price = n; break; }
          }
        }

        // Fallback: regex search for SAR price pattern in container text
        if (!price) {
          const txt = container.textContent;
          const m = txt.match(/(?:SAR|ر\.س|SR)\s*([\d,]+\.?\d*)/i)
                 || txt.match(/([\d,]+\.?\d*)\s*(?:SAR|ر\.س|SR)/i)
                 || txt.match(/(\d+\.\d{2})/);
          if (m) {
            const n = parseFloat(m[1].replace(/,/g, ''));
            if (n > 0 && n < 10000) price = n;
          }
        }

        // Extract image
        const img = container.querySelector('img[src], img[data-src], img[srcset]');
        if (img) {
          image = img.getAttribute('src') ||
                  img.getAttribute('data-src') ||
                  (img.getAttribute('srcset') || '').split(' ')[0];
        }

        // Extract URL
        const a = container.querySelector('a[href]');
        if (a) url = a.href;

        if (name && price) results.push({ name, price, image, url });
      }

      if (results.length >= 3) break;
    }

    /* 3. Last resort: scan ALL text for price patterns if we still have nothing */
    if (!results.length) {
      const allText = document.body.innerText;
      const priceMatches = [...allText.matchAll(/([\w\s,]+?)\s+(?:SAR|ر\.س)\s+([\d.]+)/gi)];
      priceMatches.slice(0, 5).forEach(m => {
        const price = parseFloat(m[2]);
        if (price > 0) results.push({ name: m[1].trim(), price, image: '', url: window.location.href });
      });
    }

    return results.slice(0, 8);
  }, storeName);
}

/* ─── Individual store scrapers ────────────────────────────────── */

const STORES = [
  {
    id:   'noon',
    name: 'Noon Daily',
    ar:   'نون',
    emoji: '⚫',
    color: '#f9c74f',
    url:  q => `https://www.noon.com/saudi-en/search/?q=${encodeURIComponent(q)}&cat=grocery`,
    waitFor: '[data-qa="product-name"], [class*="productContainer"], .sc-bdVTJa',
  },
  {
    id:   'carrefour',
    name: 'Carrefour',
    ar:   'كارفور',
    emoji: '🔴',
    color: '#003087',
    url:  q => `https://www.carrefourksa.com/mafsau/en/c/KSFDB?q=${encodeURIComponent(q)}&searchType=regular`,
    waitFor: 'cx-product-grid-item, .product-card, .item',
  },
  {
    id:   'panda',
    name: 'Panda',
    ar:   'بنده',
    emoji: '🐼',
    color: '#e63946',
    url:  q => `https://www.panda.com.sa/en/search?q=${encodeURIComponent(q)}`,
    waitFor: 'salla-product-card, .salla-product-card, .product-card',
  },
  {
    id:   'danube',
    name: 'Danube',
    ar:   'دانوب',
    emoji: '🔵',
    color: '#1d3557',
    url:  q => `https://www.danube.com.sa/search?q=${encodeURIComponent(q)}`,
    waitFor: '.product-card, .product, [class*="product"]',
  },
  {
    id:   'lulu',
    name: 'LuLu Hypermarket',
    ar:   'لولو',
    emoji: '🟢',
    color: '#2a9d8f',
    url:  q => `https://www.luluhypermarket.com/en-sa/search?q=${encodeURIComponent(q)}`,
    waitFor: '.product-item, .product-card, li.product',
  },
  {
    id:   'tamimi',
    name: 'Tamimi Markets',
    ar:   'التميمي',
    emoji: '🏪',
    color: '#457b9d',
    url:  q => `https://www.tamimimarkets.com/search?type=product&q=${encodeURIComponent(q)}`,
    waitFor: '.product-card, .grid__item, .product-item',
  },
  {
    id:   'othaim',
    name: 'Othaim',
    ar:   'العثيم',
    emoji: '🟡',
    color: '#f4a261',
    url:  q => `https://www.othaim.com.sa/search?q=${encodeURIComponent(q)}`,
    waitFor: '.product-card, .product-item, .product',
  },
  {
    id:   'bindawood',
    name: 'Bin Dawood',
    ar:   'بن داود',
    emoji: '🟠',
    color: '#e76f51',
    url:  q => `https://bindawood.com/search?q=${encodeURIComponent(q)}`,
    waitFor: '.product-card, .product-item, [class*="product"]',
  },
];

async function scrapeStore(store, query) {
  const result = { storeId: store.id, storeName: store.name, storeAr: store.ar,
                   storeEmoji: store.emoji, storeColor: store.color,
                   products: [], error: null };
  let page = null;
  try {
    const browser = await getBrowser();
    page = await newPage(browser);
    await page.goto(store.url(query), {
      timeout: 25000,
      waitUntil: 'domcontentloaded',
    });

    // Wait for either products or a short timeout
    try {
      await page.waitForSelector(store.waitFor, { timeout: 8000 });
    } catch (_) {
      // Selector may not match exactly — still try to extract
    }

    // Extra wait for JS-heavy pages
    await page.waitForTimeout(2000);

    result.products = await extractProducts(page, store.name);
  } catch (err) {
    result.error = err.message.split('\n')[0];
    // If browser crashed, clear the instance so it gets recreated next time
    if (browserInstance && !browserInstance.isConnected()) {
      browserInstance = null;
    }
  } finally {
    if (page) {
      await page.context().close().catch(() => {});
    }
  }
  return result;
}

/* ─── API endpoint ─────────────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing query parameter ?q=' });

  console.log(`[search] "${query}"`);

  try {
    // Scrape stores with limited concurrency (2 at a time) to avoid browser crashes
    const storeResults = [];
    for (let i = 0; i < STORES.length; i += 2) {
      const batch = STORES.slice(i, i + 2);
      const batchResults = await Promise.all(batch.map(store => scrapeStore(store, query)));
      storeResults.push(...batchResults);
    }

    // Build unified product list: for each store, take top match
    const response = {
      query,
      timestamp: new Date().toISOString(),
      stores: storeResults.map(sr => ({
        id:      sr.storeId,
        name:    sr.storeName,
        ar:      sr.storeAr,
        emoji:   sr.storeEmoji,
        color:   sr.storeColor,
        products: sr.products,
        error:   sr.error,
      })),
    };

    res.json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ─── In-memory log ring buffer ────────────────────────────────── */
const MAX_LOGS = 200;
const recentLogs = [];

function addLog(level, ...args) {
  const entry = { ts: new Date().toISOString(), level, msg: args.join(' ') };
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
}

const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
console.log   = (...a) => { _origLog(...a);   addLog('info',  ...a.map(String)); };
console.error = (...a) => { _origError(...a); addLog('error', ...a.map(String)); };

/* ─── Health check ─────────────────────────────────────────────── */
app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  browser: browserInstance ? (browserInstance.isConnected() ? 'connected' : 'disconnected') : 'none',
  stores: STORES.map(s => s.id),
  proxy: PROXY_URL ? 'configured' : 'none',
  timestamp: new Date().toISOString(),
}));

/* ─── Recent logs ───────────────────────────────────────────────── */
app.get('/api/logs', (req, res) => {
  const n = Math.min(parseInt(req.query.n || '50', 10), MAX_LOGS);
  res.json({ logs: recentLogs.slice(-n) });
});

/* ─── Serve frontend ───────────────────────────────────────────── */
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'grocery.html')));

/* ─── Start ────────────────────────────────────────────────────── */
app.listen(PORT, async () => {
  console.log(`\n🛒  GroceryCompare SA  →  http://localhost:${PORT}`);
  console.log(`     Proxy: ${PROXY_URL ? `✅ ${PROXY_URL}` : '❌ none (add PROXY_URL env var for Saudi exit node)'}\n`);
});

process.on('SIGINT', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
