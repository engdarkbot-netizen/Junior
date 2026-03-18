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

const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const zlib         = require('zlib');
const compression  = require('compression');
const { chromium, request: playwrightRequest } = require('playwright');

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

/* ─── Compression middleware ────────────────────────────────────── */
// compression() handles HTML/static files; the custom wrapper below
// handles JSON responses (keeps Content-Length accurate for gzip'd JSON)
app.use(compression({
  filter: (req, res) => {
    // Skip SSE streams (must not be buffered/compressed)
    if (res.getHeader('Content-Type')?.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
  threshold: 1024, // only compress responses > 1KB
}));

// Custom JSON gzip wrapper (ensures Content-Length is set correctly)
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

/* ─── Pre-gzip grocery.html at startup ─────────────────────────── */
const fs = require('fs');
let gzippedHtml = null;

(function warmGroceryHtml() {
  try {
    const htmlPath = path.join(__dirname, 'grocery.html');
    const raw = fs.readFileSync(htmlPath);
    zlib.gzip(raw, (err, buf) => {
      if (!err) {
        gzippedHtml = buf;
        console.log(`[startup] grocery.html gzipped (${buf.length} bytes)`);
      }
    });
  } catch (e) {
    console.error('[startup] Could not pre-gzip grocery.html:', e.message);
  }
})();

// Serve grocery.html as the homepage (before static so it takes priority over index.html)
app.get('/', (req, res) => {
  const ae = req.headers['accept-encoding'] || '';
  if (gzippedHtml && ae.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', gzippedHtml.length);
    return res.end(gzippedHtml);
  }
  res.sendFile(path.join(__dirname, 'grocery.html'));
});
app.use(express.static(path.join(__dirname)));

/* ─── In-memory savings counter (social proof) ─────────────────── */
let totalSavingsDisplayed = 0;
let totalSearches = 0;

/* ─── GET /manifest.json — PWA manifest ────────────────────────── */
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json({
    name: 'جونيور — أسعار المواد الغذائية',
    short_name: 'جونيور',
    description: 'قارن أسعار البقالة في 8 متاجر سعودية',
    start_url: '/',
    display: 'standalone',
    background_color: '#0f5132',
    theme_color: '#0f5132',
    lang: 'ar',
    dir: 'rtl',
    icons: [
      { src: 'https://placehold.co/192x192/0f5132/white?text=J', sizes: '192x192', type: 'image/png' },
      { src: 'https://placehold.co/512x512/0f5132/white?text=J', sizes: '512x512', type: 'image/png' },
    ],
  });
});

/* ─── GET /api/stats/savings — savings social proof counter ─────── */
app.get('/api/stats/savings', (req, res) => {
  res.json({ totalSavings: Math.round(totalSavingsDisplayed * 100) / 100, searches: totalSearches });
});

/* ─── In-memory search cache (15-minute TTL, max 150 entries) ──── */
const CACHE_TTL = 15 * 60 * 1000;
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

/* ─── In-memory price history (server-side) ────────────────────
 * Stores last 10 lowest-price observations per normalised query.
 * Structure: Map<nKey, Array<{ lowestPrice, ts }>>
 * ────────────────────────────────────────────────────────────── */
const PRICE_HISTORY_MAX = 10;
const priceHistory = new Map(); // nKey -> [{ lowestPrice, ts }, ...]

function recordPriceHistory(nKey, stores) {
  const prices = [];
  (stores || []).forEach(s => {
    (s.products || []).forEach(p => { if (p.price > 0) prices.push(p.price); });
  });
  if (!prices.length) return;
  const lowestPrice = Math.min(...prices);
  const observations = priceHistory.get(nKey) || [];
  observations.push({ lowestPrice, ts: new Date().toISOString() });
  if (observations.length > PRICE_HISTORY_MAX) observations.shift();
  priceHistory.set(nKey, observations);
}

/* ─── In-memory price alerts ────────────────────────────────────
 * key: `${email}:${nKey}`, value: { email, query, targetPrice, createdAt }
 * Max 5 alerts per email address.
 * ────────────────────────────────────────────────────────────── */
const priceAlerts = new Map();

/* ─── In-flight request deduplication ─────────────────────────── */
const inflight = new Map(); // key -> Promise

/* ─── Search analytics ─────────────────────────────────────────── */
const analytics = {
  totalSearches: 0,
  cacheHits:     0,
  cacheMisses:   0,
  queryCount:    new Map(),    // normalizedQuery -> count
  queryLastSeen: new Map(),    // normalizedQuery -> timestamp
  queryOriginal: new Map(),    // normalizedQuery -> first original user query
  storeResults:  new Map(),    // storeId -> { success, fail, totalProducts }
  responseTimes: [],           // last 500 { query, ms, cached, ts }
  startedAt:     Date.now(),
};

function trackSearch(nKey, ms, cached, stores, originalQuery) {
  analytics.totalSearches++;
  if (cached) analytics.cacheHits++;
  else        analytics.cacheMisses++;
  analytics.queryCount.set(nKey, (analytics.queryCount.get(nKey) || 0) + 1);
  analytics.queryLastSeen.set(nKey, Date.now());
  // Keep the first original query seen for this normalized key
  if (originalQuery && !analytics.queryOriginal.has(nKey)) {
    analytics.queryOriginal.set(nKey, originalQuery);
  }
  analytics.responseTimes.push({ query: nKey, ms, cached, ts: Date.now() });
  if (analytics.responseTimes.length > 500) analytics.responseTimes.shift();
  if (stores) {
    stores.forEach(s => {
      if (!analytics.storeResults.has(s.id))
        analytics.storeResults.set(s.id, { success: 0, fail: 0, totalProducts: 0 });
      const r = analytics.storeResults.get(s.id);
      if (s.error && !(s.products && s.products.length)) {
        r.fail++;
        r.lastError = { message: s.error, timestamp: new Date().toISOString() };
      }
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

/* ─── Demo mode ─────────────────────────────────────────────────
 * Auto-enabled when:
 *  a) Playwright/Chromium is unavailable, OR
 *  b) No PROXY_URL is configured (Saudi stores block non-Saudi IPs,
 *     so scraping from Railway/Render US datacenter always returns 0)
 * ────────────────────────────────────────────────────────────── */
let DEMO_MODE = false;
let DEMO_REASON = null; // 'no_proxy' | 'browser_unavailable' | 'forced' | null

if (process.env.FORCE_DEMO === '1' || process.env.FORCE_DEMO === 'true') {
  DEMO_MODE = true;
  DEMO_REASON = 'forced';
  console.log('⚠️  FORCE_DEMO=1 — running in DEMO MODE');
}

if (!PROXY_URL) {
  DEMO_MODE = true;
  DEMO_REASON = 'no_proxy';
  console.log('⚠️  No PROXY_URL set — running in DEMO MODE (Saudi stores require a Saudi residential proxy)');
} else {
  // Only test browser when a proxy is configured and scraping may work
  (async () => {
    try {
      const testBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      await testBrowser.close();
    } catch (_) {
      DEMO_MODE = true;
      DEMO_REASON = 'browser_unavailable';
      console.log('⚠️  Playwright/Chromium unavailable — running in DEMO MODE (mock data)');
    }
  })();
}

// Each category entry: keywords (Arabic/English) that map to its products
const DEMO_CATALOG = [
  {
    keywords: ['milk', 'حليب', 'حلب', 'مراعي', 'الجهينه', 'جهينه', 'نادك'],
    products: [
      { name: 'حليب المراعي كامل الدسم ٢ لتر', price: 8.50, image: '', url: '#' },
      { name: 'حليب المراعي قليل الدسم ٢ لتر', price: 8.25, image: '', url: '#' },
      { name: 'حليب الجهينة طازج ٢ لتر',        price: 7.95, image: '', url: '#' },
      { name: 'حليب نادك كامل الدسم ١ لتر',     price: 4.50, image: '', url: '#' },
      { name: 'حليب UHT المراعي ١ لتر (٤ عبوات)', price: 18.75, image: '', url: '#' },
    ],
  },
  {
    keywords: ['rice', 'أرز', 'ارز', 'بسمتي', 'السله', 'الكيف'],
    products: [
      { name: 'أرز السلة بسمتي ٢ كجم',              price: 14.95, image: '', url: '#' },
      { name: 'أرز الكيف بسمتي طويل الحبة ٥ كجم',  price: 32.50, image: '', url: '#' },
      { name: 'أرز المراعي بسمتي ١ كجم',            price:  8.75, image: '', url: '#' },
      { name: 'أرز تمر هندي بسمتي ٢ كجم',           price: 13.25, image: '', url: '#' },
    ],
  },
  {
    keywords: ['water', 'مياه', 'ماء', 'نيوم', 'بيتا', 'مياة'],
    products: [
      { name: 'مياه نيوم ١.٥ لتر (٦ عبوات)',     price: 11.50, image: '', url: '#' },
      { name: 'مياه بيتا ١.٥ لتر',               price:  1.95, image: '', url: '#' },
      { name: 'مياه المراعي ٠.٥ لتر (١٢ عبوة)', price:  9.75, image: '', url: '#' },
      { name: 'مياه هنا ١.٥ لتر (٦ عبوات)',     price: 10.50, image: '', url: '#' },
    ],
  },
  {
    keywords: ['eggs', 'egg', 'بيض', 'بيضه', 'بيضة'],
    products: [
      { name: 'بيض المراعي وايت ٣٠ بيضة',  price: 19.95, image: '', url: '#' },
      { name: 'بيض بلدي طازج ١٥ بيضة',    price: 13.50, image: '', url: '#' },
      { name: 'بيض الوطنية ٣٠ بيضة',       price: 18.75, image: '', url: '#' },
    ],
  },
  {
    keywords: ['bread', 'خبز', 'عيش', 'تميس', 'صامولي', 'بالدي'],
    products: [
      { name: 'خبز عيش بلدي (١٠ أرغفة)',         price:  2.50, image: '', url: '#' },
      { name: 'خبز صامولي أبيض كبير (٦ حبات)',    price:  4.75, image: '', url: '#' },
      { name: 'خبز تميس كامل الحبة (٥ حبات)',     price:  5.95, image: '', url: '#' },
      { name: 'خبز التوست الذهبي بر ٥٠٠ جم',      price:  6.25, image: '', url: '#' },
      { name: 'خبز الحبوب الكاملة لوزان ٤٠٠ جم', price:  8.50, image: '', url: '#' },
    ],
  },
  {
    keywords: ['chicken', 'دجاج', 'فراخ', 'فروج', 'كنتاكي', 'مبرد'],
    products: [
      { name: 'دجاج كامل طازج مبرد (١.٨ كجم تقريباً)', price: 22.95, image: '', url: '#' },
      { name: 'صدر دجاج طازج مبرد ١ كجم',              price: 19.50, image: '', url: '#' },
      { name: 'أفخاذ دجاج مبردة ١ كجم',               price: 14.75, image: '', url: '#' },
      { name: 'دجاج مقطع ٨ قطع مبرد',                  price: 26.95, image: '', url: '#' },
      { name: 'فيليه دجاج مجمد نادك ٩٠٠ جم',           price: 24.50, image: '', url: '#' },
    ],
  },
  {
    keywords: ['oil', 'زيت', 'زيوت', 'نخيل', 'ذرة', 'طبخ', 'cooking'],
    products: [
      { name: 'زيت دوار الشمس نيدو ١.٥ لتر',    price: 14.95, image: '', url: '#' },
      { name: 'زيت الذرة المراعي ١.٨ لتر',       price: 16.50, image: '', url: '#' },
      { name: 'زيت زيتون بكر ممتاز لوزيان ٧٥٠مل', price: 34.95, image: '', url: '#' },
      { name: 'زيت نخيل مكرر ١.٥ لتر',           price: 11.25, image: '', url: '#' },
    ],
  },
  {
    keywords: ['sugar', 'سكر', 'سكره', 'محلى'],
    products: [
      { name: 'سكر أبيض ناعم ٢ كجم',       price:  8.25, image: '', url: '#' },
      { name: 'سكر قصب بني ١ كجم',          price:  9.50, image: '', url: '#' },
      { name: 'سكر أبيض ٥ كجم المراعي',    price: 18.75, image: '', url: '#' },
      { name: 'سكر بودرة ناعم ٥٠٠ جم',     price:  5.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['coffee', 'قهوة', 'قهوه', 'نسكافيه', 'نسكافيه', 'كافيه', 'espresso', 'nescafe'],
    products: [
      { name: 'نسكافيه كلاسيك ٢٠٠ جم',            price: 34.95, image: '', url: '#' },
      { name: 'قهوة عربية بالهيل المراعي ٢٥٠ جم', price: 22.50, image: '', url: '#' },
      { name: 'قهوة نسبريسو كبسولات ١٠ حبة',      price: 49.95, image: '', url: '#' },
      { name: 'نسكافيه جولد ٢٠٠ جم',              price: 52.50, image: '', url: '#' },
      { name: 'قهوة دانكن دونتس أصلي ٢٨٦ جم',    price: 39.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['dates', 'تمر', 'تمور', 'عجوه', 'مجدول', 'خلاص', 'سكري'],
    products: [
      { name: 'تمر سكري فاخر ١ كجم',       price: 28.95, image: '', url: '#' },
      { name: 'تمر مجدول مغربي ٥٠٠ جم',   price: 39.95, image: '', url: '#' },
      { name: 'تمر عجوة المدينة ٥٠٠ جم',  price: 45.00, image: '', url: '#' },
      { name: 'تمر خلاص فاخر ١ كجم',      price: 32.50, image: '', url: '#' },
      { name: 'تمر صفاوي ١ كجم',           price: 24.75, image: '', url: '#' },
    ],
  },
  {
    keywords: ['yogurt', 'زبادي', 'زباده', 'يوغرت', 'لبن رايب', 'لبن'],
    products: [
      { name: 'زبادي المراعي طبيعي ٤ × ١٧٠ جم', price:  8.50, image: '', url: '#' },
      { name: 'زبادي الجهينة بالفراولة ١٧٠ جم', price:  2.75, image: '', url: '#' },
      { name: 'لبن رايب المراعي ٤٠٠ مل',         price:  5.25, image: '', url: '#' },
      { name: 'زبادي يوناني لاكنوز ١٥٠ جم',      price:  3.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['cheese', 'جبن', 'جبنه', 'جبنة', 'كريم', 'شيدر', 'موزاريلا'],
    products: [
      { name: 'جبن شيدر كرافت شرائح ٢٠٠ جم',      price: 16.95, image: '', url: '#' },
      { name: 'جبن كريمي فيلادلفيا ١٧٥ جم',        price: 18.50, image: '', url: '#' },
      { name: 'جبن أبيض طري المراعي ٥٠٠ جم',       price: 14.25, image: '', url: '#' },
      { name: 'جبن موزاريلا مبشور ٢٠٠ جم',         price: 19.95, image: '', url: '#' },
      { name: 'جبن حلوم مشوي الطيبات ٢٥٠ جم',      price: 22.75, image: '', url: '#' },
    ],
  },
  {
    keywords: ['tomato', 'tomatoes', 'طماطم', 'طمطم', 'بندوره', 'بندورة'],
    products: [
      { name: 'طماطم طازجة ١ كجم',              price:  4.95, image: '', url: '#' },
      { name: 'طماطم كرزية ٢٥٠ جم',            price:  6.50, image: '', url: '#' },
      { name: 'معجون طماطم هاينز ١٣٥ جم',      price:  4.25, image: '', url: '#' },
      { name: 'صلصة طماطم إيطالية باريلا ٤٠٠ جم', price: 11.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['onion', 'onions', 'بصل', 'بصله', 'ثوم'],
    products: [
      { name: 'بصل أبيض طازج ١ كجم',    price:  3.95, image: '', url: '#' },
      { name: 'بصل أحمر طازج ١ كجم',    price:  4.50, image: '', url: '#' },
      { name: 'ثوم طازج رأس (٣ رؤوس)', price:  5.25, image: '', url: '#' },
      { name: 'بصل أخضر (٢٠٠ جم)',      price:  2.95, image: '', url: '#' },
    ],
  },
  /* ── NEW CATEGORIES (Iteration 8) ─────────────────────────── */
  {
    keywords: ['pasta', 'macaroni', 'معكرونة', 'مكرونة', 'مكارونة', 'باريلا', 'سباغيتي'],
    products: [
      { name: 'مكرونة باريلا سباغيتي ٥٠٠ جم',         price:  9.50, image: '', url: '#' },
      { name: 'مكرونة باريلا بيني ٥٠٠ جم',            price:  9.50, image: '', url: '#' },
      { name: 'مكرونة ملوكي سباغيتي ٩٠٠ جم',          price:  5.95, image: '', url: '#' },
      { name: 'مكرونة ماما سباغيتي ٤٠٠ جم',           price:  3.75, image: '', url: '#' },
      { name: 'مكرونة المراعي فيتوتشيني ٥٠٠ جم',      price:  7.25, image: '', url: '#' },
    ],
  },
  {
    keywords: ['laundry', 'detergent', 'washing powder', 'مسحوق غسيل', 'ارييل', 'تايد', 'persil', 'ariel', 'tide'],
    products: [
      { name: 'مسحوق غسيل أريال أوتوماتيك ٣ كجم',     price: 39.95, image: '', url: '#' },
      { name: 'مسحوق غسيل تايد بلاس ٤ كجم',           price: 45.50, image: '', url: '#' },
      { name: 'مسحوق غسيل برسيل ملونات ٢.٥ كجم',      price: 34.95, image: '', url: '#' },
      { name: 'مسحوق غسيل OMO نشط ٣ كجم',             price: 29.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['baby formula', 'infant formula', 'حليب اطفال', 'حليب أطفال', 'نان', 'سيميلاك', 'similac', 'nan', 'aptamil'],
    products: [
      { name: 'حليب نان أوبتيبرو ١ للرضع ٠-٦ أشهر ٩٠٠ جم',  price: 129.95, image: '', url: '#' },
      { name: 'حليب سيميلاك أدفانس ١ للرضع ٩٠٠ جم',         price: 115.00, image: '', url: '#' },
      { name: 'حليب أبتاميل ١ للرضع ٩٠٠ جم',                price: 135.00, image: '', url: '#' },
      { name: 'حليب نان كومفورت ١ للرضع ٨٠٠ جم',            price: 119.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['juice', 'عصير', 'عصائر', 'المراعي عصير', 'راني', 'rani', 'almarai juice', 'تروبيكانا', 'tropicana'],
    products: [
      { name: 'عصير المراعي برتقال ١ لتر',              price:  7.50, image: '', url: '#' },
      { name: 'عصير راني مانجو ١.٥ لتر',                price:  8.95, image: '', url: '#' },
      { name: 'عصير تروبيكانا برتقال ١ لتر',            price: 14.95, image: '', url: '#' },
      { name: 'عصير المراعي تفاح ١ لتر',                price:  7.50, image: '', url: '#' },
      { name: 'عصير راني خوخ ٢٥٠ مل (٦ علب)',          price: 12.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['chips', 'snacks', 'crisps', 'شيبس', 'بطاطس', 'بطاطا', 'ليز', 'pringles', 'lays'],
    products: [
      { name: 'شيبس ليز كلاسيك ١٦٧ جم',               price: 12.95, image: '', url: '#' },
      { name: 'شيبس برينجلز أوريجينال ١٦٥ جم',         price: 14.50, image: '', url: '#' },
      { name: 'شيبس تام تام ببرونية ١٢٠ جم',           price:  6.95, image: '', url: '#' },
      { name: 'شيبس ليز بالجبنة ١٦٧ جم',              price: 12.95, image: '', url: '#' },
      { name: 'شيبس ميكسد نكهات متعددة ٢٤ كيس',       price: 29.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['tissues', 'paper towels', 'مناديل', 'كلينكس', 'ورق', 'kleenex', 'tissue', 'napkins'],
    products: [
      { name: 'مناديل كلينكس ناعمة ٢ طبقة ١٠٠ × ٤ علب', price: 19.95, image: '', url: '#' },
      { name: 'مناديل ورقية عيش الغراب ٢٠٠ ورقة',      price:  7.50, image: '', url: '#' },
      { name: 'مناديل كلينكس منثول ٦٠ ورقة',           price:  6.95, image: '', url: '#' },
      { name: 'ورق مطبخ باون باور ٢ لفة',              price:  9.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['shampoo', 'شامبو', 'هيد اند شولدرز', 'head shoulders', 'pantene', 'pantin', 'dove shampoo'],
    products: [
      { name: 'شامبو هيد آند شولدرز ضد القشرة ٤٠٠ مل', price: 24.95, image: '', url: '#' },
      { name: 'شامبو بانتين للشعر الجاف ٤٠٠ مل',       price: 22.50, image: '', url: '#' },
      { name: 'شامبو داف موتشر ٤٠٠ مل',                price: 21.95, image: '', url: '#' },
      { name: 'شامبو لوريال برو ليسيك ٤٠٠ مل',         price: 34.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['diapers', 'nappies', 'حفاضات', 'حفاضه', 'بامبرز', 'هاجيز', 'pampers', 'huggies'],
    products: [
      { name: 'حفاضات بامبرز مقاس ٤ (٩-١٤ كجم) ٤٤ حبة',    price: 69.95, image: '', url: '#' },
      { name: 'حفاضات هاجيز ناتشرا كير مقاس ٤ ٤٢ حبة',     price: 64.95, image: '', url: '#' },
      { name: 'حفاضات بامبرز نيو بيبي مقاس ٣ ٥٦ حبة',      price: 74.95, image: '', url: '#' },
      { name: 'حفاضات هاجيز بلس مقاس ٥ ٣٦ حبة',            price: 59.95, image: '', url: '#' },
    ],
  },
  {
    keywords: ['canned', 'foul', 'hummus', 'tuna', 'فول', 'حمص', 'تونة', 'معلبات', 'فول مدمس'],
    products: [
      { name: 'فول مدمس السنونو ٤٠٠ جم',               price:  4.25, image: '', url: '#' },
      { name: 'حمص بالطحينة شاميات ٤٠٠ جم',            price:  5.50, image: '', url: '#' },
      { name: 'تونة بالزيت بيلاكو ١٧٠ جم',            price:  8.95, image: '', url: '#' },
      { name: 'فول مدمس بالزيتون سيف ٤٠٠ جم',          price:  4.75, image: '', url: '#' },
      { name: 'تونة باراميون بالماء ٣ × ١٧٠ جم',       price: 22.50, image: '', url: '#' },
    ],
  },
  {
    keywords: ['frozen', 'frozen meals', 'وجبات مجمدة', 'بيتزا مجمدة', 'مجمد', 'pizza frozen', 'frozen food'],
    products: [
      { name: 'بيتزا دكتور أوتكر مارغريتا مجمدة ٣٣٠ جم',  price: 24.95, image: '', url: '#' },
      { name: 'برغر دجاج مجمد نادك ٤ قطع ٤٠٠ جم',         price: 29.95, image: '', url: '#' },
      { name: 'سمبوسة لحم مجمدة ٢٠ قطعة ٤٠٠ جم',          price: 19.95, image: '', url: '#' },
      { name: 'وجبة كبسة دجاج مجمدة كاملة ٨٠٠ جم',        price: 39.95, image: '', url: '#' },
      { name: 'نقانق دجاج مجمد نادك ٤٠٠ جم',              price: 18.50, image: '', url: '#' },
    ],
  },
];

// Default fallback (milk — most commonly searched)
const DEMO_DEFAULT = DEMO_CATALOG[0].products;

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

// Build a normalized keyword→products lookup from DEMO_CATALOG
const DEMO_PRODUCTS_NORMALIZED = { default: DEMO_DEFAULT };
for (const entry of DEMO_CATALOG) {
  for (const kw of entry.keywords) {
    DEMO_PRODUCTS_NORMALIZED[normalizeQuery(kw)] = entry.products;
  }
}

function getDemoProducts(query, storeId) {
  const key = normalizeQuery(query);
  // Find best matching demo set using normalized keys (fixes أ→ا mismatch)
  let products = DEMO_PRODUCTS_NORMALIZED.default;
  for (const [normKey, v] of Object.entries(DEMO_PRODUCTS_NORMALIZED)) {
    if (normKey === 'default') continue;
    if (key.includes(normKey) || normKey.includes(key)) { products = v; break; }
  }
  const variance = STORE_VARIANCE[storeId] || 0;
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

/* ─── Playwright API request context (lightweight proxy-aware HTTP) */
let _apiCtx = null;

async function getApiCtx() {
  if (_apiCtx) return _apiCtx;
  const opts = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: {
      'Accept-Language': 'ar-SA,ar;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept':          'application/json, text/plain, */*',
    },
    ignoreHTTPSErrors: true,
  };
  if (PROXY_URL) {
    opts.proxy = {
      server:   PROXY_URL,
      username: PROXY_USER || undefined,
      password: PROXY_PASS || undefined,
    };
  }
  _apiCtx = await playwrightRequest.newContext(opts);
  return _apiCtx;
}

async function fetchJsonApi(url, extraHeaders = {}) {
  try {
    const ctx = await getApiCtx();
    const resp = await ctx.get(url, {
      headers: extraHeaders,
      timeout: 20000,
    });
    if (!resp.ok()) {
      console.log(`[api] ${resp.status()} from ${url.split('?')[0].split('/').slice(-2).join('/')}`);
      return null;
    }
    return await resp.json().catch(() => null);
  } catch (err) {
    console.log(`[api] fetch failed: ${err.message.split('\n')[0]}`);
    return null;
  }
}

/* ─── Browser concurrency limiter ─────────────────────────────── */
// Running 8 browser pages simultaneously can exhaust Railway container RAM.
// Cap at 4 concurrent pages — API stores don't count against this limit.
const MAX_BROWSER_PAGES = 4;
let activeBrowserPages  = 0;
const browserPageQueue  = [];

function acquireBrowserSlot() {
  if (activeBrowserPages < MAX_BROWSER_PAGES) {
    activeBrowserPages++;
    return Promise.resolve();
  }
  return new Promise(resolve => browserPageQueue.push(resolve));
}

function releaseBrowserSlot() {
  const next = browserPageQueue.shift();
  if (next) { next(); } else { activeBrowserPages--; }
}

/* ─── Browser pool ─────────────────────────────────────────────── */
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--disable-extensions',
      '--disable-background-networking',
    ];
    // Pass proxy at browser level too (belt-and-suspenders)
    if (PROXY_URL) {
      args.push(`--proxy-server=${PROXY_URL}`);
    }
    browserInstance = await chromium.launch({ headless: true, args });
  }
  return browserInstance;
}

async function newPage(browser) {
  const contextOptions = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
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

  // Block images, fonts, media — only HTML/JS/XHR needed for scraping
  // This speeds up page load significantly through the proxy
  await ctx.route(/\.(woff2?|ttf|eot|otf|mp4|mp3|webm|gif|png|jpe?g|svg|ico|webp)(\?.*)?$/, r => r.abort());

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
      // Direct API response: { hits: [...] } or nested
      const hits = json.hits || json.data?.hits || json.results?.hits
                || json.searchResult?.hits || [];
      if (hits.length) return hits.slice(0, 10).map(h => ({
        name:  h.name || h.title || h.display_name || '',
        price: parseArabicPrice(h.sale_price ?? h.price?.sale_price ?? h.price ?? 0),
        image: h.image_keys?.[0]
          ? `https://f.nooncdn.com/p/${h.image_keys[0]}t.jpg`
          : (h.image || h.thumbnail || ''),
        url: h.url ? `https://www.noon.com${h.url}` : (h.sku ? `https://www.noon.com/saudi-en/${h.sku}/` : ''),
      })).filter(p => p.name && p.price > 0);
    }

    // ── Carrefour (SAP Hybris OCC v2) ────────────────────────
    if (storeId === 'carrefour') {
      const products = json.products || json.data?.products || [];
      if (products.length) return products.slice(0, 10).map(p => ({
        name:  p.name || '',
        price: parseArabicPrice(p.price?.value ?? p.price ?? 0),
        image: p.images?.[0]?.url || p.image?.url || '',
        url:   p.url ? `https://www.carrefourksa.com${p.url}` : (p.code ? `https://www.carrefourksa.com/mafsau/en/p/${p.code}` : ''),
      })).filter(p => p.name && p.price > 0);
    }

    // ── Tamimi (Shopify) ─────────────────────────────────────
    if (storeId === 'tamimi') {
      const products = json.resources?.results?.products
                    || json.products
                    || json.items || [];
      if (products.length) return products.slice(0, 10).map(p => ({
        name:  p.title || p.name || '',
        // suggest.json returns price as display string in SAR (e.g. "8.95")
        // The main product API returns cents — suggest.json does NOT
        price: parseArabicPrice(p.price),
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
    waitFor: '[data-qa="product-name"], [class*="productContainer"], [class*="productCard"], .sc-bdVTJa, [class*="product"]',
  },
  {
    id:   'carrefour',
    name: 'Carrefour',
    ar:   'كارفور',
    emoji: '🔴',
    color: '#003087',
    // SAP Hybris OCC v2 — standard endpoint, no auth needed for search
    apiUrl: q => `https://www.carrefourksa.com/mafsau/v2/products/search?query=${encodeURIComponent(q)}&lang=en&curr=SAR&pageSize=20&fields=FULL`,
    apiHeaders: { 'Accept': 'application/json' },
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
    waitFor: 'salla-product-card, .salla-product-card, .product-card, [class*="product"]',
  },
  {
    id:   'danube',
    name: 'Danube',
    ar:   'دانوب',
    emoji: '🔵',
    color: '#1d3557',
    url:  q => `https://www.danube.com.sa/search?q=${encodeURIComponent(q)}`,
    waitFor: '.product-card, .product, [class*="product"], .item',
  },
  {
    id:   'lulu',
    name: 'LuLu Hypermarket',
    ar:   'لولو',
    emoji: '🟢',
    color: '#2a9d8f',
    url:  q => `https://www.luluhypermarket.com/en-sa/search?q=${encodeURIComponent(q)}`,
    waitFor: '.product-item, .product-card, li.product, [class*="product"]',
  },
  {
    id:   'tamimi',
    name: 'Tamimi Markets',
    ar:   'التميمي',
    emoji: '🏪',
    color: '#457b9d',
    // Shopify Storefront API — no auth required, proxy-friendly
    apiUrl: q => `https://www.tamimimarkets.com/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[options][limit]=10`,
    apiHeaders: { 'Accept': 'application/json' },
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
    waitFor: '.product-card, .product-item, .product, [class*="product"]',
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

  // ── Tier 1: lightweight direct JSON API (no browser overhead) ──
  if (store.apiUrl) {
    try {
      const json = await fetchJsonApi(store.apiUrl(query), store.apiHeaders || {});
      if (json) {
        const products = extractFromApiJson(json, store.id);
        if (products.length > 0) {
          result.products = products.slice(0, 8);
          console.log(`[${store.id}] "${query}" → ${result.products.length} products (direct-API)`);
          return result;
        }
        console.log(`[${store.id}] direct-API returned 0 products, falling back to browser`);
      }
    } catch (err) {
      console.log(`[${store.id}] direct-API error: ${err.message.split('\n')[0]}`);
    }
  }

  // ── Tier 2: full browser scrape ───────────────────────────────
  let page = null;
  const capturedApiProducts = [];

  await acquireBrowserSlot(); // throttle concurrent pages to avoid OOM

  try {
    const browser = await getBrowser();
    page = await newPage(browser);

    // Intercept JSON API responses fired by the SPA JS
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
          console.log(`[${store.id}] XHR captured ${products.length} products from ${url.split('?')[0].split('/').slice(-2).join('/')}`);
        }
      } catch (_) {}
    });

    // domcontentloaded is faster than 'load' — avoids waiting for every
    // image/font through the proxy before we can check for products
    await page.goto(store.url(query), {
      timeout: 40000,
      waitUntil: 'domcontentloaded',
    }).catch(e => {
      console.log(`[${store.id}] goto timed out / failed: ${e.message.split('\n')[0]}`);
    });

    // Wait for SPA JS to initialize and fire search API calls
    await page.waitForTimeout(3000);

    // If XHR already gave us products, skip DOM wait
    if (capturedApiProducts.length < 2) {
      try {
        await page.waitForSelector(store.waitFor, { timeout: 8000 });
      } catch (_) {}
      // Scroll to trigger lazy-loaded product grids
      await page.evaluate(() => {
        window.scrollTo({ top: document.body.scrollHeight / 2, behavior: 'instant' });
      }).catch(() => {});
      await page.waitForTimeout(2000);
    }

    // Prefer XHR-captured data; fall back to DOM extraction
    if (capturedApiProducts.length >= 1) {
      result.products = capturedApiProducts
        .filter((p, i, a) => a.findIndex(x => x.name === p.name) === i)
        .slice(0, 8);
    } else {
      result.products = await extractProducts(page, store.name);
    }
    const method = capturedApiProducts.length ? 'XHR' : 'DOM';
    console.log(`[${store.id}] "${query}" → ${result.products.length} products (browser-${method})`);

  } catch (err) {
    result.error = err.message.split('\n')[0];
    console.log(`[${store.id}] browser error: ${result.error}`);
    if (browserInstance && !browserInstance.isConnected()) {
      browserInstance = null;
    }
  } finally {
    releaseBrowserSlot();
    if (page) {
      await page.context().close().catch(() => {});
    }
  }
  return result;
}

/* ─── Shared scrape runner (used by both endpoints) ────────────── */
async function runScrape(query) {
  // In demo mode we normally return fake data. But first try the direct-API
  // stores (Tamimi Shopify, Carrefour OCC) — these work from any IP globally
  // without a proxy. If they return products, mix real + demo for the rest.
  if (DEMO_MODE) {
    const apiOnlyStores = STORES.filter(s => s.apiUrl);
    if (apiOnlyStores.length > 0) {
      const apiResults = await Promise.all(apiOnlyStores.map(s => scrapeStore(s, query)));
      const apiCount = apiResults.reduce((n, r) => n + r.products.length, 0);
      if (apiCount > 0) {
        console.log(`[scrape] Demo mode but direct-API returned ${apiCount} real products`);
        const demoData = runDemoScrape(query);
        const apiMap = Object.fromEntries(apiResults.map(r => [r.storeId, r]));
        return {
          ...demoData,
          demo: 'partial',
          stores: demoData.stores.map(ds => {
            const real = apiMap[ds.id];
            return real && real.products.length > 0
              ? { ...ds, products: real.products, error: null }
              : ds;
          }),
        };
      }
    }
    return runDemoScrape(query);
  }

  const storeResults = await Promise.all(STORES.map(store => scrapeStore(store, query)));

  const totalProducts = storeResults.reduce((sum, sr) => sum + (sr.products?.length || 0), 0);

  if (totalProducts === 0) {
    console.log(`[scrape] "${query}" — all stores returned 0. proxy=${PROXY_URL ? 'set' : 'none'}. Check /api/test-proxy and /api/debug-search`);
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

/* ─── Price alert checker (called after each search) ───────────── */
function checkPriceAlerts(nKey, stores) {
  const prices = [];
  (stores || []).forEach(s => {
    (s.products || []).forEach(p => { if (p.price > 0) prices.push(p.price); });
  });
  if (!prices.length) return;
  const lowestPrice = Math.min(...prices);

  for (const [key, alert] of priceAlerts) {
    if (alert.query === nKey && lowestPrice <= alert.targetPrice) {
      console.log(`[alert] FIRED for ${alert.email} — "${nKey}" lowest price ${lowestPrice} <= target ${alert.targetPrice} (email sending is future work)`);
    }
  }
}

/* ─── GET /api/ping — uptime probe ─────────────────────────────── */
app.get('/api/ping', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('pong');
});

/* ─── GET /api/test-proxy — verify proxy routing ───────────────── */
app.get('/api/test-proxy', async (_req, res) => {
  const safeProxy = PROXY_URL ? PROXY_URL.replace(/:[^:@]*@/, ':***@') : null;
  if (!PROXY_URL) {
    return res.json({ ok: false, error: 'No PROXY_URL configured', proxy: null });
  }
  const results = {};

  // Test 1: lightweight API context
  try {
    const json = await fetchJsonApi('https://api.ipify.org?format=json');
    results.apiContext = json ? { ok: true, ip: json.ip } : { ok: false, error: 'empty response' };
  } catch (err) {
    results.apiContext = { ok: false, error: err.message.split('\n')[0] };
  }

  // Test 2: full browser context
  let page = null;
  try {
    const browser = await getBrowser();
    page = await newPage(browser);
    const resp = await page.goto('https://api.ipify.org?format=json', {
      timeout: 20000, waitUntil: 'domcontentloaded',
    });
    const json = await resp.json();
    results.browserContext = { ok: true, ip: json.ip };
  } catch (err) {
    results.browserContext = { ok: false, error: err.message.split('\n')[0] };
  } finally {
    if (page) await page.context().close().catch(() => {});
  }

  const ok = results.apiContext?.ok || results.browserContext?.ok;
  res.json({ ok, proxy: safeProxy, results });
});

/* ─── GET /api/debug-search — per-store scrape diagnostic ──────── */
app.get('/api/debug-search', async (req, res) => {
  const query   = (req.query.q     || 'milk').trim();
  const storeId = (req.query.store || '').trim();
  const targets = storeId ? STORES.filter(s => s.id === storeId) : STORES;

  if (!targets.length) {
    return res.status(400).json({ error: `Unknown store: ${storeId}. Valid: ${STORES.map(s => s.id).join(', ')}` });
  }

  console.log(`[debug-search] query="${query}" stores=${targets.map(s => s.id)}`);
  const results = await Promise.all(targets.map(async s => {
    const t0 = Date.now();
    const r  = await scrapeStore(s, query);
    return {
      store:   s.id,
      count:   r.products.length,
      sample:  r.products[0] || null,
      error:   r.error,
      ms:      Date.now() - t0,
    };
  }));

  res.json({ query, demoMode: DEMO_MODE, proxy: PROXY_URL ? 'configured' : 'none', results });
});

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
    trackSearch(key, 0, true, hit.data.stores, query); // cache hits have near-zero latency
    return res.json({ ...hit.data, cached: true, cacheAge: age });
  }

  // In-flight dedup
  if (inflight.has(key)) {
    console.log(`[search] "${query}" — dedup`);
    res.setHeader('X-Cache', 'DEDUP');
    const data = await inflight.get(key);
    trackSearch(key, 0, false, data.stores, query);
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
    trackSearch(key, Date.now() - t0, false, data.stores, query);
    res.json(data);
  } catch (err) {
    console.error('[search error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ─── GET /api/search/stream — Server-Sent Events ──────────────── */
app.get('/api/search/stream', rateLimit, async (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing query parameter ?q=' });
  if (query.length > MAX_QUERY_LEN) return res.status(400).json({ error: `Query too long (max ${MAX_QUERY_LEN} characters)` });
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

  let usedDemoFallback = false;
  write('start', { query, stores: STORES.length, demo: DEMO_MODE });

  const allResults = [];

  if (DEMO_MODE) {
    // In demo mode, try direct-API stores first (work globally without proxy)
    const apiStores    = STORES.filter(s => s.apiUrl);
    const nonApiStores = STORES.filter(s => !s.apiUrl);

    // Run direct-API stores in parallel
    const apiResults = await Promise.all(apiStores.map(async store => {
      const r = await scrapeStore(store, query);
      const products = r.products.length > 0 ? r.products : getDemoProducts(query, store.id);
      const storeData = { id: store.id, name: store.name, ar: store.ar,
                          emoji: store.emoji, color: store.color, products, error: r.error };
      write('store', storeData);
      return storeData;
    }));
    allResults.push(...apiResults);

    // Stream demo results for non-API stores with realistic delays
    for (const store of nonApiStores) {
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
    const results = await Promise.all(STORES.map(store =>
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

    // Only fall back to demo when no proxy is configured
    const totalProducts = allResults.reduce((sum, s) => sum + (s.products?.length || 0), 0);
    if (totalProducts === 0 && !PROXY_URL) {
      console.log(`[stream] No products found for "${query}" — no proxy configured, using demo data`);
      for (let i = 0; i < allResults.length; i++) {
        allResults[i] = {
          ...allResults[i],
          products: getDemoProducts(query, allResults[i].id),
          error: null,
        };
      }
      usedDemoFallback = true;
    } else if (totalProducts === 0) {
      console.log(`[stream] No products found for "${query}" — proxy configured but all stores returned 0`);
    }
  }

  const finalData = { query, timestamp: new Date().toISOString(), demo: DEMO_MODE || usedDemoFallback || undefined, stores: allResults };
  cacheSet(key, finalData);
  trackSearch(key, 0, false, allResults, query);
  write('done', finalData);
  res.end();
});

/* ─── POST /api/search/batch — parallel multi-query search ─────── */
app.post('/api/search/batch', express.json(), rateLimit, async (req, res) => {
  const { queries } = req.body || {};
  if (!Array.isArray(queries) || queries.length === 0) {
    return res.status(400).json({ error: 'Body must include a non-empty "queries" array' });
  }
  if (queries.length > 5) {
    return res.status(400).json({ error: 'Maximum 5 queries per batch request' });
  }

  const results = await Promise.all(queries.map(async (q) => {
    const query = (q || '').trim();
    if (!query) return { query: q, stores: [] };
    const key = normalizeQuery(query);
    const hit = cacheGet(key);
    if (hit) return { query, stores: hit.data.stores };
    try {
      const data = await runScrape(query);
      cacheSet(key, data);
      recordPriceHistory(key, data.stores);
      return { query, stores: data.stores };
    } catch (err) {
      return { query, stores: [], error: err.message };
    }
  }));

  res.json({ results });
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
  const queries = [...new Set(rawQueries.map(q => (q || '').trim()).filter(Boolean))]; // dedup
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

  // Track savings for social proof counter
  totalSearches++;
  const completedStores = stores.filter(s => s.missing === 0 && s.total > 0);
  if (completedStores.length >= 2) {
    const highestTotal = Math.max(...completedStores.map(s => s.total));
    const lowestTotal  = Math.min(...completedStores.map(s => s.total));
    const savings = highestTotal - lowestTotal;
    if (savings > 0) totalSavingsDisplayed += savings;
  }

  res.json({ queries, stores, timestamp: new Date().toISOString() });
});

/* ─── POST /api/alerts — create a price alert ──────────────────── */
app.post('/api/alerts', express.json(), (req, res) => {
  const { email, query, targetPrice } = req.body || {};

  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid or missing email' });
  }
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'Invalid or missing query' });
  }
  const price = parseFloat(targetPrice);
  if (isNaN(price) || price <= 0) {
    return res.status(400).json({ error: 'targetPrice must be a number greater than 0' });
  }

  const nKey = normalizeQuery(query.trim());
  const alertKey = `${email}:${nKey}`;

  // Enforce max 5 alerts per email
  const emailAlerts = [...priceAlerts.values()].filter(a => a.email === email);
  if (emailAlerts.length >= 5 && !priceAlerts.has(alertKey)) {
    return res.status(400).json({ error: 'Maximum 5 alerts per email address' });
  }

  const alert = { email, query: nKey, targetPrice: price, createdAt: new Date().toISOString() };
  priceAlerts.set(alertKey, alert);

  res.status(201).json({ success: true, alertId: alertKey, alert });
});

/* ─── GET /api/alerts — list alerts for an email ───────────────── */
app.get('/api/alerts', (req, res) => {
  const email = (req.query.email || '').trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid or missing email query parameter' });
  }
  const alerts = [...priceAlerts.values()].filter(a => a.email === email);
  res.json({ email, alerts });
});

/* ─── GET /api/trending — top searched queries ─────────────────── */
app.get('/api/trending', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '10', 10), 20);
  const trending = [...analytics.queryCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([nKey, count]) => ({
      query:        analytics.queryOriginal.get(nKey) || nKey,
      count,
      lastSearched: new Date(analytics.queryLastSeen.get(nKey) || Date.now()).toISOString(),
    }));
  res.json({ trending, total: analytics.totalSearches });
});

/* ─── GET /api/history — price history for a query ────────────── */
app.get('/api/history', (req, res) => {
  const query = (req.query.q || '').trim();
  if (!query) return res.status(400).json({ error: 'Missing query parameter ?q=' });
  const nKey = normalizeQuery(query);
  const observations = priceHistory.get(nKey) || [];
  res.json({ query, normalizedQuery: nKey, observations: observations.slice(-10) });
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

  const errorLogs = recentLogs.filter(e => e.level === 'error');

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
                     .map(([nKey, count]) => ({
                       query:        analytics.queryOriginal.get(nKey) || nKey,
                       count,
                       lastSearched: new Date(analytics.queryLastSeen.get(nKey) || Date.now()).toISOString(),
                     })),
    stores,
    demoMode:    DEMO_MODE,
    demoReason:  DEMO_REASON,
    alertsCount: priceAlerts.size,
  });
});

/* ─── POST /api/admin/clear-cache — clears the search result cache ─ */
// TODO: add admin auth token check
app.post('/api/admin/clear-cache', (req, res) => {
  const cleared = searchCache.size;
  searchCache.clear();
  res.json({ cleared, timestamp: new Date().toISOString() });
});

/* ─── POST /api/admin/reset-analytics — resets analytics counters ── */
// TODO: add admin auth token check
app.post('/api/admin/reset-analytics', (req, res) => {
  analytics.totalSearches = 0;
  analytics.cacheHits     = 0;
  analytics.cacheMisses   = 0;
  analytics.queryCount.clear();
  analytics.queryLastSeen.clear();
  analytics.storeResults.clear();
  analytics.responseTimes.length = 0;
  analytics.startedAt     = Date.now();
  res.json({ reset: true, timestamp: new Date().toISOString() });
});

/* ─── Health check ─────────────────────────────────────────────── */
app.get('/api/health', (_, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  browser: DEMO_MODE ? 'unavailable (demo mode)' : (browserInstance ? (browserInstance.isConnected() ? 'connected' : 'disconnected') : 'none'),
  demo: DEMO_MODE,
  demoReason: DEMO_REASON,
  stores: STORES.map(s => s.id),
  proxy: PROXY_URL ? 'configured' : 'none',
  timestamp: new Date().toISOString(),
}));

/* ─── GET /api/version — runtime info ──────────────────────────── */
app.get('/api/version', (_req, res) => {
  res.json({
    version:     require('./package.json').version,
    env:         process.env.NODE_ENV || 'development',
    nodeVersion: process.version,
    platform:    process.platform,
  });
});

/* ─── Recent logs ───────────────────────────────────────────────── */
app.get('/api/logs', (req, res) => {
  const n = Math.min(parseInt(req.query.n || '50', 10), MAX_LOGS);
  res.json({ logs: recentLogs.slice(-n) });
});

/* ─── JSON 404 for /api/* routes (must be after all api routes) ── */
app.use('/api', (req, res) => {
  res.status(404).json({ error: `API endpoint not found: ${req.method} ${req.path}` });
});

/* ─── Start ────────────────────────────────────────────────────── */
const httpServer = app.listen(PORT, async () => {
  const modeLabel = DEMO_MODE ? `DEMO (${DEMO_REASON || 'no proxy'})` : 'LIVE (proxy set)';
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  GroceryCompare SA  — http://localhost:${PORT}${' '.repeat(Math.max(0, 4 - String(PORT).length))}  ║`);
  console.log(`║  Mode: ${modeLabel}${' '.repeat(Math.max(0, 38 - modeLabel.length))}║`);
  console.log(`║  Stores: 8  |  Demo catalog: 14 categories  ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  // Cache warming: pre-populate the top 5 most searched terms after a short delay
  const WARM_TERMS = ['حليب', 'أرز', 'دجاج', 'بيض', 'خبز'];
  setTimeout(async () => {
    console.log('[cache-warm] Starting cache warm-up for top terms…');
    for (const term of WARM_TERMS) {
      try {
        const key = normalizeQuery(term);
        if (!cacheGet(key)) {
          const data = await runScrape(term);
          cacheSet(key, data);
          console.log(`[cache-warm] Warmed: "${term}"`);
        }
      } catch (e) {
        console.error(`[cache-warm] Failed for "${term}":`, e.message);
      }
    }
    console.log('[cache-warm] Cache warm-up complete');
  }, 2000);
});

/* ─── Graceful shutdown ─────────────────────────────────────────── */
async function shutdown(signal) {
  console.log(`\n[${signal}] Graceful shutdown initiated…`);

  // Force-exit if shutdown takes longer than 10 s
  const forceExit = setTimeout(() => {
    console.error('Shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  // 1. Stop accepting new HTTP requests
  httpServer.close(() => console.log('HTTP server closed'));

  // 2. Close the browser
  try {
    if (browserInstance) await browserInstance.close();
    console.log('Browser closed');
  } catch (err) {
    console.error('Error closing browser:', err.message);
  }

  clearTimeout(forceExit);
  process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
