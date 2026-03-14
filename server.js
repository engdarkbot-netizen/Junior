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

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const zlib       = require('zlib');
const { chromium } = require('playwright');

/* ─── Arabic/English query normaliser ──────────────────────────── */
const MAX_QUERY_LEN = 200;

function normalizeQuery(q) {
  return q
    .trim()
    .slice(0, MAX_QUERY_LEN)
    .toLowerCase()
    .replace(/[<>"'`]/g, '')                 // strip HTML-dangerous chars before storing
    .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)) // Arabic-Indic → ASCII digits
    .replace(/[\u064B-\u065F\u0670]/g, '')   // strip diacritics (tashkeel)
    .replace(/[أإآٱ]/g, 'ا')                 // unify alef variants
    .replace(/ة/g, 'ه')                      // ta marbuta → ha
    .replace(/ى/g, 'ي')                      // alef maqsura → ya
    .replace(/\s+/g, ' ');
}

const app  = express();
const PORT = process.env.PORT || 3000;

/* ─── Compression middleware (gzip/deflate) ────────────────────── */
app.use((req, res, next) => {
  const ae = req.headers['accept-encoding'] || '';
  if (!ae.includes('gzip')) return next();
  const _json = res.json.bind(res);
  res.json = (data) => {
    const body = JSON.stringify(data);
    zlib.gzip(Buffer.from(body), (err, buf) => {
      if (err) return _json(data);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', buf.length);
      res.end(buf);
    });
  };
  next();
});

/* ─── Trust Railway/Render proxy for IP detection ─────────────── */
app.set('trust proxy', 1);

/* ─── Proxy config (optional) ──────────────────────────────────── */
const PROXY_URL  = process.env.PROXY_URL  || null;
const PROXY_USER = process.env.PROXY_USER || null;
const PROXY_PASS = process.env.PROXY_PASS || null;

app.use(cors());
// Serve grocery.html as the homepage (before static so it takes priority over index.html)
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'grocery.html')));
app.use(express.static(path.join(__dirname)));

/* ─── In-memory search cache (5-minute TTL, max 150 entries) ───── */
const CACHE_TTL = 5 * 60 * 1000;
const CACHE_MAX = 150;
const searchCache = new Map(); // key -> { data, ts }

function cacheGet(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { searchCache.delete(key); return null; }
  return entry;
}
function cacheSet(key, data) {
  if (searchCache.size >= CACHE_MAX) {
    // Evict oldest entry
    const oldestKey = searchCache.keys().next().value;
    searchCache.delete(oldestKey);
  }
  searchCache.set(key, { data, ts: Date.now() });
}

/* ─── In-flight request deduplication ─────────────────────────── */
const inflight = new Map(); // key -> Promise

/* ─── Search analytics ─────────────────────────────────────────── */
const analytics = {
  totalSearches: 0,
  cacheHits:     0,
  cacheMisses:   0,
  queryCount:    new Map(),  // normalizedQuery -> count
  queryLastSeen: new Map(),  // normalizedQuery -> timestamp
  storeResults:  new Map(),  // storeId -> { success, fail, totalProducts }
  responseTimes: [],         // last 500 { query, ms, cached, ts }
  startedAt:     Date.now(),
};

function trackSearch(nKey, ms, cached, stores) {
  analytics.totalSearches++;
  if (cached) analytics.cacheHits++;
  else        analytics.cacheMisses++;
  analytics.queryCount.set(nKey, (analytics.queryCount.get(nKey) || 0) + 1);
  analytics.queryLastSeen.set(nKey, Date.now());
  analytics.responseTimes.push({ query: nKey, ms, cached, ts: Date.now() });
  if (analytics.responseTimes.length > 500) analytics.responseTimes.shift();
  if (stores) {
    stores.forEach(s => {
      if (!analytics.storeResults.has(s.id))
        analytics.storeResults.set(s.id, { success: 0, fail: 0, totalProducts: 0 });
      const r = analytics.storeResults.get(s.id);
      if (s.error && !(s.products && s.products.length)) r.fail++;
      else { r.success++; r.totalProducts += s.products ? s.products.length : 0; }
    });
  }
}

/* ─── Simple per-IP rate limiter (20 req/min) ──────────────────── */
const RATE_LIMIT   = 20;
const RATE_WINDOW  = 60 * 1000;
const rateLimitMap = new Map(); // ip -> { count, resetAt }

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

function rateLimit(req, res, next) {
  const ip  = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW };
  }
  entry.count++;
  rateLimitMap.set(ip, entry);

  res.setHeader('X-RateLimit-Limit',     String(RATE_LIMIT));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - entry.count)));
  res.setHeader('X-RateLimit-Reset',     new Date(entry.resetAt).toISOString());

  if (entry.count > RATE_LIMIT) {
    return res.status(429).json({
      error: 'Too many requests — please wait a moment before searching again.',
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    });
  }
  next();
}

/* ─── Timing middleware ────────────────────────────────────────── */
app.use((req, res, next) => {
  req._startAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - req._startAt) / 1e6;
    if (req.path.startsWith('/api/')) {
      console.log(`[${res.statusCode}] ${req.method} ${req.path}${req.query.q ? `?q=${req.query.q}` : ''} ${ms.toFixed(0)}ms`);
    }
  });
  next();
});

/* ─── Demo mode (auto-enabled when browser unavailable) ────────── */
let DEMO_MODE = false;

// Check browser availability at startup
(async () => {
  try {
    const testBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    await testBrowser.close();
  } catch (_) {
    DEMO_MODE = true;
    console.log('⚠️  Playwright/Chromium unavailable — running in DEMO MODE (mock data)');
  }
})();

const DEMO_PRODUCTS = {
  default: [
    { name: 'حليب المراعي كامل الدسم ٢ لتر', price: 8.50, image: '', url: '#' },
    { name: 'حليب المراعي قليل الدسم ٢ لتر', price: 8.25, image: '', url: '#' },
    { name: 'حليب الجهينة كامل الدسم ٢ لتر', price: 7.95, image: '', url: '#' },
    { name: 'حليب نادك ١ لتر', price: 4.50, image: '', url: '#' },
  ],
  milk: [
    { name: 'حليب المراعي كامل الدسم ٢ لتر', price: 8.50, image: '', url: '#' },
    { name: 'حليب المراعي قليل الدسم ٢ لتر', price: 8.25, image: '', url: '#' },
    { name: 'حليب الجهينة طازج ٢ لتر', price: 7.95, image: '', url: '#' },
    { name: 'حليب نادك كامل الدسم ١ لتر', price: 4.50, image: '', url: '#' },
    { name: 'حليب UHT المراعي ١ لتر (٤ عبوات)', price: 18.75, image: '', url: '#' },
  ],
  حليب: [
    { name: 'حليب المراعي كامل الدسم ٢ لتر', price: 8.50, image: '', url: '#' },
    { name: 'حليب المراعي قليل الدسم ٢ لتر', price: 8.25, image: '', url: '#' },
    { name: 'حليب الجهينة طازج ٢ لتر', price: 7.95, image: '', url: '#' },
    { name: 'حليب نادك كامل الدسم ١ لتر', price: 4.50, image: '', url: '#' },
    { name: 'حليب UHT المراعي ١ لتر (٤ عبوات)', price: 18.75, image: '', url: '#' },
  ],
  rice: [
    { name: 'أرز السلة بسمتي ٢ كجم', price: 14.95, image: '', url: '#' },
    { name: 'أرز الكيف بسمتي طويل الحبة ٥ كجم', price: 32.50, image: '', url: '#' },
    { name: 'أرز المراعي بسمتي ١ كجم', price: 8.75, image: '', url: '#' },
  ],
  أرز: [
    { name: 'أرز السلة بسمتي ٢ كجم', price: 14.95, image: '', url: '#' },
    { name: 'أرز الكيف بسمتي طويل الحبة ٥ كجم', price: 32.50, image: '', url: '#' },
    { name: 'أرز المراعي بسمتي ١ كجم', price: 8.75, image: '', url: '#' },
  ],
  water: [
    { name: 'مياه نيوم ١.٥ لتر (٦ عبوات)', price: 11.50, image: '', url: '#' },
    { name: 'مياه بيتا ١.٥ لتر', price: 1.95, image: '', url: '#' },
    { name: 'مياه المراعي ٠.٥ لتر (١٢ عبوة)', price: 9.75, image: '', url: '#' },
  ],
  eggs: [
    { name: 'بيض المراعي وايت ٣٠ بيضة', price: 19.95, image: '', url: '#' },
    { name: 'بيض بلدي طازج ١٥ بيضة', price: 13.50, image: '', url: '#' },
  ],
  بيض: [
    { name: 'بيض المراعي وايت ٣٠ بيضة', price: 19.95, image: '', url: '#' },
    { name: 'بيض بلدي طازج ١٥ بيضة', price: 13.50, image: '', url: '#' },
  ],
};

// Price variance per store (±%) to simulate price differences
const STORE_VARIANCE = {
  noon:      +0.05,
  carrefour: -0.03,
  panda:     +0.08,
  danube:    -0.01,
  lulu:      -0.06,
  tamimi:    +0.02,
  othaim:    -0.04,
  bindawood: +0.01,
};

function getDemoProducts(query, storeId) {
  const key = normalizeQuery(query);
  // Find best matching demo set
  let products = DEMO_PRODUCTS.default;
  for (const [k, v] of Object.entries(DEMO_PRODUCTS)) {
    if (key.includes(k) || k.includes(key)) { products = v; break; }
  }
  const variance = STORE_VARIANCE[storeId] || 0;
  // Apply per-store price variance and round to 2dp
  return products.map(p => ({
    ...p,
    price: Math.round(p.price * (1 + variance) * 100) / 100,
    url: STORES.find(s => s.id === storeId)?.url(query) || '#',
  }));
}

async function runDemoScrape(query) {
  // Simulate realistic latency per store
  await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  return {
    query,
    timestamp: new Date().toISOString(),
    demo: true,
    stores: STORES.map(s => ({
      id:       s.id,
      name:     s.name,
      ar:       s.ar,
      emoji:    s.emoji,
      color:    s.color,
      products: getDemoProducts(query, s.id),
      error:    null,
    })),
  };
}

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

  // Block fonts, media — keep HTML/JS/XHR for SPA rendering
  await ctx.route(/\.(woff2?|ttf|eot|otf|mp4|mp3|webm|gif)(\?.*)?$/, r => r.abort());

  // Mask Playwright fingerprint
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    Object.defineProperty(navigator, 'language',  { get: () => 'ar-SA' });
    Object.defineProperty(navigator, 'languages', { get: () => ['ar-SA', 'ar', 'en-US'] });
    window.chrome = { runtime: {} };
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
        // Noon — explicit data-qa
        '[data-qa="product-container"]',
        '[data-qa="product"]',
        // Generic data attributes
        '[data-testid*="product"]',
        '[data-qa*="product"]',
        '[data-component*="product"]',
        '[data-product-id]',
        '[data-item-id]',
        // SAP Spartacus (Carrefour)
        'cx-product-grid-item',
        'cx-product-list-item',
        // Salla platform (Panda, others)
        'salla-product-card',
        '.salla-product-card',
        // Noon (React, dynamic class names)
        '[class*="productContainer"]',
        '[class*="productCard"]',
        '[class*="ProductCard"]',
        '[class*="product-container"]',
        '[class*="productBox"]',
        // SAP Spartacus (Carrefour) — kept for fallback
        'cx-product-grid-item',
        'cx-product-list-item',
        // Magento 2 (LuLu, Othaim, Danube)
        '.product-item-info',
        '.product-item',
        'li.product',
        '.item.product',
        // Shopify (Tamimi)
        '[class*="ProductItem"]',
        '[class*="product-item"]',
        '.grid__item',
        // Danube / Bin Dawood
        '[class*="ProductCard"]',
        '[class*="product_card"]',
        '.product-card',
        '.product',
      ],
      names: [
        // Noon
        '[data-qa="product-name"]',
        // Carrefour Spartacus
        '.cx-product-name', 'cx-product-name a',
        // Generic
        '[data-qa*="name"]', '[data-testid*="name"]',
        '[class*="product-name"]', '[class*="productName"]',
        '[class*="ProductName"]', '[class*="product_name"]',
        '[class*="product-title"]', '[class*="productTitle"]',
        '.product-title', '.product-name', 'h2.name', 'h3.name', 'h4',
        '.item-name', '.title', 'a[title]',
        'salla-product-card [slot="title"]',
      ],
      prices: [
        // Noon
        '[data-qa="price"]',
        // Carrefour Spartacus
        '.cx-price .Value', '.cx-price',
        // Generic
        '[data-qa*="price"]', '[data-testid*="price"]',
        '[class*="product-price"]', '[class*="productPrice"]',
        '[class*="ProductPrice"]', '[class*="product_price"]',
        '[class*="price--sale"]', '[class*="price__sale"]',
        '[class*="priceText"]', '[class*="price-text"]',
        '.price', '.price__current', '.price-box', '.special-price',
        '[class*="finalPrice"]', '[class*="final-price"]',
        'salla-price', 'salla-product-card [slot="price"]',
      ],
    };

    // Try each container selector
    for (const sel of SELECTORS.containers) {
      const containers = [...document.querySelectorAll(sel)];
      if (containers.length < 1) continue;

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
            const raw = el.textContent
              .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))  // Arabic-Indic → ASCII
              .replace(/[^\d.٫٬,]/g, '')
              .replace(/٫/g, '.').replace(/٬/g, '').replace(/,/g, '');
            const n = parseFloat(raw);
            if (n > 0) { price = n; break; }
          }
        }

        // Fallback: regex search for SAR price pattern in container text
        if (!price) {
          const txt = container.textContent
            .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
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

/* ─── Per-store API JSON extractors (network interception) ─────── */
function parseArabicPrice(str) {
  return parseFloat(
    String(str)
      .replace(/[٠١٢٣٤٥٦٧٨٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/[^\d.]/g, '')
  ) || 0;
}

function extractFromApiJson(json, storeId) {
  try {
    // ── Noon ──────────────────────────────────────────────────
    if (storeId === 'noon') {
      const hits = json.hits || json.data?.hits || json.results?.hits || [];
      if (hits.length) return hits.slice(0, 10).map(h => ({
        name:  h.name  || h.title || '',
        price: parseArabicPrice(h.sale_price ?? h.price ?? 0),
        image: h.image_keys?.[0]
          ? `https://f.nooncdn.com/p/${h.image_keys[0]}t.jpg`
          : (h.image || ''),
        url: h.url ? `https://www.noon.com${h.url}` : '',
      })).filter(p => p.name && p.price > 0);
    }

    // ── Carrefour (SAP Spartacus OCC) ────────────────────────
    if (storeId === 'carrefour') {
      const products = json.products || json.data?.products || [];
      if (products.length) return products.slice(0, 10).map(p => ({
        name:  p.name || '',
        price: parseArabicPrice(p.price?.value ?? p.price ?? 0),
        image: p.images?.[0]?.url || p.image?.url || '',
        url:   p.url ? `https://www.carrefourksa.com${p.url}` : '',
      })).filter(p => p.name && p.price > 0);
    }

    // ── Tamimi (Shopify) ─────────────────────────────────────
    if (storeId === 'tamimi') {
      const products = json.resources?.results?.products
                    || json.products
                    || json.items || [];
      if (products.length) return products.slice(0, 10).map(p => ({
        name:  p.title || p.name || '',
        // Shopify: price is in cents as string e.g. "895" = 8.95
        price: parseArabicPrice(p.price) > 100
               ? parseArabicPrice(p.price) / 100
               : parseArabicPrice(p.price),
        image: p.image || p.featured_image || '',
        url:   p.url ? `https://www.tamimimarkets.com${p.url}` : '',
      })).filter(p => p.name && p.price > 0);
    }

    // ── Panda (Salla) ────────────────────────────────────────
    if (storeId === 'panda') {
      const products = json.data || json.products || json.items || [];
      if (Array.isArray(products) && products.length) {
        return products.slice(0, 10).map(p => ({
          name:  p.name?.ar || p.name?.en || p.name || p.title || '',
          price: parseArabicPrice(p.price?.amount ?? p.price ?? 0),
          image: p.thumbnail || p.image?.url || '',
          url:   p.url || p.slug || '',
        })).filter(p => p.name && p.price > 0);
      }
    }

    // ── Danube ───────────────────────────────────────────────
    if (storeId === 'danube') {
      const products = json.products || json.data?.products || json.items || [];
      if (Array.isArray(products) && products.length) {
        return products.slice(0, 10).map(p => ({
          name:  p.name || p.title || '',
          price: parseArabicPrice(p.price?.final_price ?? p.price ?? 0),
          image: p.image || p.thumbnail || '',
          url:   p.url || '',
        })).filter(p => p.name && p.price > 0);
      }
    }

    // ── Generic: walk JSON tree for product arrays ───────────
    const candidates = [];
    function walkJson(node, depth = 0) {
      if (depth > 5 || candidates.length >= 10) return;
      if (Array.isArray(node) && node.length >= 1) {
        const first = node[0];
        if (first && typeof first === 'object') {
          const hasName  = 'name' in first || 'title' in first;
          const hasPrice = 'price' in first || 'sale_price' in first || 'amount' in first;
          if (hasName && hasPrice) {
            node.slice(0, 10).forEach(p => {
              const name  = p.name || p.title || '';
              const price = parseArabicPrice(
                p.sale_price ?? p.price?.amount ?? p.price?.value ?? p.price ?? 0
              );
              if (name && price > 0) candidates.push({ name, price, image: p.image || '', url: p.url || '' });
            });
            return;
          }
        }
      }
      if (node && typeof node === 'object' && !Array.isArray(node)) {
        for (const val of Object.values(node)) {
          if (val && typeof val === 'object') walkJson(val, depth + 1);
        }
      }
    }
    walkJson(json);
    return candidates;
  } catch (_) {
    return [];
  }
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
    waitFor: '[data-qa="product-name"], [class*="productContainer"], [class*="productCard"], .sc-bdVTJa',
  },
  {
    id:   'carrefour',
    name: 'Carrefour',
    ar:   'كارفور',
    emoji: '🔴',
    color: '#003087',
    url:  q => `https://www.carrefourksa.com/mafsau/en/search?q=${encodeURIComponent(q)}&searchType=regular`,
    waitFor: 'cx-product-grid-item, cx-product-card, .product-card, [class*="product"]',
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
    waitFor: '.product-card, .grid__item, .product-item, [class*="ProductItem"]',
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
    url:  q => `https://www.bindawood.com/search?q=${encodeURIComponent(q)}`,
    waitFor: '.product-card, .product-item, [class*="product"]',
  },
];

async function scrapeStore(store, query) {
  const result = { storeId: store.id, storeName: store.name, storeAr: store.ar,
                   storeEmoji: store.emoji, storeColor: store.color,
                   products: [], error: null };
  let page = null;
  const capturedApiProducts = [];

  try {
    const browser = await getBrowser();
    page = await newPage(browser);

    // ── Intercept JSON API responses before DOM scraping ──────
    const SKIP_API = /\.(css|js|woff|png|jpg|svg|ico|gif|mp4)(\?|$)/i;
    const SKIP_HOST = /analytics|tracking|gtm\.js|clarity|hotjar|facebook|google-analytics/i;

    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (SKIP_API.test(url) || SKIP_HOST.test(url)) return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;
        const json = await response.json();
        const products = extractFromApiJson(json, store.id);
        if (products.length > 0) {
          capturedApiProducts.push(...products);
          console.log(`[${store.id}] API captured ${products.length} products from ${url.split('?')[0].split('/').slice(-2).join('/')}`);
        }
      } catch (_) {}
    });

    // Use 'load' so JS-rendered content is available; fall back on timeout
    await page.goto(store.url(query), {
      timeout: 28000,
      waitUntil: 'load',
    }).catch(() => {}); // page timeout is non-fatal — we may have API data

    // If API already gave us enough, skip DOM wait
    if (capturedApiProducts.length < 2) {
      try {
        await page.waitForSelector(store.waitFor, { timeout: 7000 });
      } catch (_) {}
      // Scroll mid-page to trigger lazy-loaded product grids
      await page.evaluate(() => {
        window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'instant' });
      }).catch(() => {});
      await page.waitForTimeout(1500);
    }

    // Prefer API-captured data; fall back to DOM extraction
    if (capturedApiProducts.length >= 1) {
      result.products = capturedApiProducts
        .filter((p, i, a) => a.findIndex(x => x.name === p.name) === i) // dedup
        .slice(0, 8);
    } else {
      result.products = await extractProducts(page, store.name);
    }
    console.log(`[${store.id}] "${query}" → ${result.products.length} products${capturedApiProducts.length ? ' (API)' : ' (DOM)'}`);

  } catch (err) {
    result.error = err.message.split('\n')[0];
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

/* ─── Shared scrape runner (used by both endpoints) ────────────── */
async function runScrape(query) {
  if (DEMO_MODE) return runDemoScrape(query);

  const storeResults = [];
  for (let i = 0; i < STORES.length; i += 2) {
    const batch = STORES.slice(i, i + 2);
    const batchResults = await Promise.all(batch.map(store => scrapeStore(store, query)));
    storeResults.push(...batchResults);
  }
  return {
    query,
    timestamp: new Date().toISOString(),
    stores: storeResults.map(sr => ({
      id:       sr.storeId,
      name:     sr.storeName,
      ar:       sr.storeAr,
      emoji:    sr.storeEmoji,
      color:    sr.storeColor,
      products: sr.products,
      error:    sr.error,
    })),
  };
}

/* ─── GET /api/search — cached, deduplicated ───────────────────── */
app.get('/api/search', rateLimit, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing query parameter ?q=' });
  if (query.length > MAX_QUERY_LEN) return res.status(400).json({ error: `Query too long (max ${MAX_QUERY_LEN} characters)` });

  const key = normalizeQuery(query);

  // Cache hit
  const hit = cacheGet(key);
  if (hit) {
    const age = Math.floor((Date.now() - hit.ts) / 1000);
    res.setHeader('X-Cache',     'HIT');
    res.setHeader('X-Cache-Age', `${age}s`);
    trackSearch(key, age * 1000, true, hit.data.stores);
    return res.json({ ...hit.data, cached: true, cacheAge: age });
  }

  // In-flight dedup
  if (inflight.has(key)) {
    console.log(`[search] "${query}" — dedup`);
    res.setHeader('X-Cache', 'DEDUP');
    const data = await inflight.get(key);
    trackSearch(key, 0, false, data.stores);
    return res.json(data);
  }

  // Fresh scrape
  console.log(`[search] "${query}"`);
  res.setHeader('X-Cache', 'MISS');

  const t0 = Date.now();
  const promise = runScrape(query).finally(() => inflight.delete(key));
  inflight.set(key, promise);

  try {
    const data = await promise;
    cacheSet(key, data);
    trackSearch(key, Date.now() - t0, false, data.stores);
    res.json(data);
  } catch (err) {
    console.error('[search error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET /api/search/stream — Server-Sent Events ──────────────── */
app.get('/api/search/stream', rateLimit, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query || query.length > MAX_QUERY_LEN) return res.status(400).end();
  const key = normalizeQuery(query);

  res.setHeader('Content-Type',  'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const write = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    res.flush?.();
  };

  write('start', { query, stores: STORES.length, demo: DEMO_MODE });

  const allResults = [];

  if (DEMO_MODE) {
    // Stream demo results store-by-store with realistic delays
    for (const store of STORES) {
      await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
      const storeData = {
        id: store.id, name: store.name, ar: store.ar,
        emoji: store.emoji, color: store.color,
        products: getDemoProducts(query, store.id), error: null,
      };
      write('store', storeData);
      allResults.push(storeData);
    }
  } else {
    for (let i = 0; i < STORES.length; i += 2) {
      const batch = STORES.slice(i, i + 2);
      const results = await Promise.all(batch.map(store =>
        scrapeStore(store, query).then(sr => {
          const storeData = {
            id:       sr.storeId,
            name:     sr.storeName,
            ar:       sr.storeAr,
            emoji:    sr.storeEmoji,
            color:    sr.storeColor,
            products: sr.products,
            error:    sr.error,
          };
          write('store', storeData);
          return storeData;
        })
      ));
      allResults.push(...results);
    }
  }

  const finalData = { query, timestamp: new Date().toISOString(), demo: DEMO_MODE || undefined, stores: allResults };
  cacheSet(key, finalData);
  trackSearch(key, 0, false, allResults);
  write('done', finalData);
  res.end();
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

/* ─── GET /api/basket — multi-item basket comparison ───────────── */
app.get('/api/basket', rateLimit, async (req, res) => {
  const rawQueries = Array.isArray(req.query.q) ? req.query.q : [req.query.q];
  const queries = rawQueries.map(q => (q || '').trim()).filter(Boolean);
  if (!queries.length) return res.status(400).json({ error: 'Missing query parameter ?q=' });
  if (queries.length > 10) return res.status(400).json({ error: 'Maximum 10 items per basket' });

  // Scrape/cache each query
  const itemResults = await Promise.all(queries.map(async q => {
    const key = normalizeQuery(q);
    const hit = cacheGet(key);
    if (hit) return hit.data;
    const data = await runScrape(q);
    cacheSet(key, data);
    return data;
  }));

  // Per-store totals
  const storeMap = {};
  STORES.forEach(s => {
    storeMap[s.id] = { id: s.id, name: s.name, ar: s.ar, emoji: s.emoji, color: s.color,
                       items: [], total: 0, missing: 0 };
  });

  itemResults.forEach(r => {
    STORES.forEach(s => {
      const storeResult = (r.stores || []).find(sr => sr.id === s.id);
      if (storeResult && storeResult.products && storeResult.products.length > 0) {
        const cheapest = storeResult.products.reduce((a, b) => a.price < b.price ? a : b);
        storeMap[s.id].items.push({ query: r.query, product: cheapest });
        storeMap[s.id].total += cheapest.price;
      } else {
        storeMap[s.id].missing++;
      }
    });
  });

  // Round totals to avoid floating-point precision artefacts (e.g. 6.060000000005)
  Object.values(storeMap).forEach(s => {
    s.total = Math.round(s.total * 100) / 100;
  });

  const stores = Object.values(storeMap)
    .filter(s => s.total > 0 || s.missing > 0)
    .sort((a, b) => {
      if (a.missing !== b.missing) return a.missing - b.missing;
      return a.total - b.total;
    });

  res.json({ queries, stores, timestamp: new Date().toISOString() });
});

/* ─── GET /api/trending — top searched queries ─────────────────── */
app.get('/api/trending', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 20);
  const trending = [...analytics.queryCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([query, count]) => ({
      query,
      count,
      lastSearched: new Date(analytics.queryLastSeen.get(query) || Date.now()).toISOString(),
    }));
  res.json({ trending, total: analytics.totalSearches });
});

/* ─── GET /api/stats — business analytics ──────────────────────── */
app.get('/api/stats', (req, res) => {
  const recent = analytics.responseTimes.slice(-100);
  const avgMs  = recent.length
    ? Math.round(recent.reduce((s, r) => s + r.ms, 0) / recent.length)
    : 0;
  const hitRate = analytics.totalSearches > 0
    ? ((analytics.cacheHits / analytics.totalSearches) * 100).toFixed(1) + '%'
    : '0.0%';

  const stores = {};
  for (const [id, r] of analytics.storeResults) {
    const total = r.success + r.fail;
    stores[id] = {
      ...r,
      successRate: total > 0 ? ((r.success / total) * 100).toFixed(1) + '%' : 'n/a',
      avgProducts: r.success > 0 ? (r.totalProducts / r.success).toFixed(1) : '0',
    };
  }

  res.json({
    uptime:        Math.floor(process.uptime()),
    startedAt:     new Date(analytics.startedAt).toISOString(),
    totalSearches: analytics.totalSearches,
    cacheHits:     analytics.cacheHits,
    cacheMisses:   analytics.cacheMisses,
    cacheHitRate:  hitRate,
    cacheSize:     searchCache.size,
    avgResponseMs: avgMs,
    uniqueQueries: analytics.queryCount.size,
    topQueries:    [...analytics.queryCount.entries()]
                     .sort((a, b) => b[1] - a[1])
                     .slice(0, 10)
                     .map(([query, count]) => ({
                       query, count,
                       lastSearched: new Date(analytics.queryLastSeen.get(query) || Date.now()).toISOString(),
                     })),
    stores,
  });
});

/* ─── Health check ─────────────────────────────────────────────── */
app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  browser: DEMO_MODE ? 'unavailable (demo mode)' : (browserInstance ? (browserInstance.isConnected() ? 'connected' : 'disconnected') : 'none'),
  demo: DEMO_MODE,
  stores: STORES.map(s => s.id),
  proxy: PROXY_URL ? 'configured' : 'none',
  timestamp: new Date().toISOString(),
}));

/* ─── Recent logs ───────────────────────────────────────────────── */
app.get('/api/logs', (req, res) => {
  const n = Math.min(parseInt(req.query.n || '50', 10), MAX_LOGS);
  res.json({ logs: recentLogs.slice(-n) });
});

/* ─── Start ────────────────────────────────────────────────────── */
app.listen(PORT, async () => {
  console.log(`\n🛒  GroceryCompare SA  →  http://localhost:${PORT}`);
  console.log(`     Proxy: ${PROXY_URL ? `✅ ${PROXY_URL}` : '❌ none (add PROXY_URL env var for Saudi exit node)'}\n`);
});

process.on('SIGINT', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
