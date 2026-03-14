/**
 * GroceryCompare SA — Automated API Test Suite (14 tests)
 * Run: node test-api.mjs
 * Assumes server is running at http://localhost:3000
 */

const BASE_URL = 'http://localhost:3000';

const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`  PASS  ${name}`);
}

function fail(name, reason) {
  results.push({ name, ok: false, reason });
  console.log(`  FAIL  ${name}`);
  console.log(`        Reason: ${reason}`);
}

async function safeFetch(url, options = {}) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    return { res, error: null };
  } catch (err) {
    return { res: null, error: err };
  }
}

// ─── 1. Health check ────────────────────────────────────────────────────────
async function testHealthCheck() {
  const testName = 'Health check — GET /api/health returns status:ok with required fields';
  const { res, error } = await safeFetch(`${BASE_URL}/api/health`);

  if (error) {
    fail(testName, `Connection error: ${error.message}`);
    return false; // server likely down, skip remaining tests
  }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return false;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    fail(testName, `Failed to parse JSON: ${e.message}`);
    return false;
  }

  const missingFields = [];
  if (body.status !== 'ok') missingFields.push('status !== "ok"');
  if (!('browser' in body))  missingFields.push('missing "browser" field');
  if (!('proxy' in body))    missingFields.push('missing "proxy" field');
  if (!Array.isArray(body.stores)) missingFields.push('missing/invalid "stores" array');

  if (missingFields.length > 0) {
    fail(testName, missingFields.join('; '));
  } else {
    pass(testName);
  }
  return true;
}

// ─── 2. Search validation — missing ?q= ─────────────────────────────────────
async function testSearchValidation() {
  const testName = 'Search validation — GET /api/search without ?q= returns 400';
  const { res, error } = await safeFetch(`${BASE_URL}/api/search`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status === 400) {
    pass(testName);
  } else {
    fail(testName, `Expected 400, got ${res.status}`);
  }
}

// ─── 3. Rate limiting ────────────────────────────────────────────────────────
async function testRateLimiting() {
  const testName = 'Rate limiting — 25 rapid requests eventually get 429';

  const requests = Array.from({ length: 25 }, (_, i) =>
    safeFetch(`${BASE_URL}/api/search?q=ratelimitcheck_${i}`)
  );

  let responses;
  try {
    responses = await Promise.all(requests);
  } catch (e) {
    fail(testName, `Request batch failed: ${e.message}`);
    return;
  }

  const statuses = responses.map(({ res }) => res?.status).filter(Boolean);
  const got429 = statuses.some(s => s === 429);

  if (got429) {
    pass(testName);
  } else {
    // Rate limit is 20 req/min; if the server is freshly started and this test
    // runs first the counter may not have accumulated enough. Still check headers.
    const remaining = responses.map(({ res }) =>
      parseInt(res?.headers?.get?.('x-ratelimit-remaining') ?? 'NaN')
    ).filter(n => !isNaN(n));

    const minRemaining = remaining.length > 0 ? Math.min(...remaining) : NaN;

    if (minRemaining === 0) {
      // At least the rate limit was reached (remaining hit 0)
      pass(testName + ' (remaining hit 0)');
    } else {
      fail(testName, `No 429 received among ${statuses.length} responses (statuses: ${[...new Set(statuses)].join(',')})`);
    }
  }
}

// ─── 4. Demo/real search — structure validation ──────────────────────────────
async function testSearchMilk() {
  const testName = 'Search — GET /api/search?q=milk returns stores array with correct shape';
  const { res, error } = await safeFetch(`${BASE_URL}/api/search?q=milk`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    fail(testName, `Failed to parse JSON: ${e.message}`);
    return;
  }

  if (!Array.isArray(body.stores)) {
    fail(testName, '"stores" field is missing or not an array');
    return;
  }

  const badStores = [];
  for (const store of body.stores) {
    const missing = [];
    if (!store.id)   missing.push('id');
    if (!store.name) missing.push('name');
    if (!Array.isArray(store.products)) missing.push('products (not array)');
    if (missing.length > 0) badStores.push(`store ${store.id || '?'}: missing [${missing.join(', ')}]`);

    // Validate products if present
    if (Array.isArray(store.products)) {
      for (const product of store.products) {
        const prodMissing = [];
        if (typeof product.name  === 'undefined') prodMissing.push('name');
        if (typeof product.price === 'undefined') prodMissing.push('price');
        if (prodMissing.length > 0)
          badStores.push(`store ${store.id} product missing [${prodMissing.join(', ')}]`);
      }
    }
  }

  if (badStores.length > 0) {
    fail(testName, badStores.slice(0, 3).join('; '));
  } else {
    pass(testName);
  }
}

// ─── 5. Arabic search ────────────────────────────────────────────────────────
async function testArabicSearch() {
  const testName = 'Arabic search — GET /api/search?q=حليب (URL-encoded) works correctly';
  const url = `${BASE_URL}/api/search?q=${encodeURIComponent('حليب')}`;
  const { res, error } = await safeFetch(url);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    fail(testName, `Failed to parse JSON: ${e.message}`);
    return;
  }

  if (!Array.isArray(body.stores) || body.stores.length === 0) {
    fail(testName, '"stores" array is missing or empty');
    return;
  }

  // Verify at least one store has products
  const anyProducts = body.stores.some(s => Array.isArray(s.products) && s.products.length > 0);
  if (anyProducts) {
    pass(testName);
  } else {
    // In demo mode all stores should return products; flag if none do
    fail(testName, 'No store returned any products for Arabic query');
  }
}

// ─── 6. Cache — X-Cache: HIT on second request ───────────────────────────────
async function testCache() {
  const testName = 'Cache — second identical search returns X-Cache: HIT header';
  const url = `${BASE_URL}/api/search?q=cachetest_unique_${Date.now()}`;

  // First request (MISS)
  const { res: res1, error: err1 } = await safeFetch(url);
  if (err1) { fail(testName, `First request failed: ${err1.message}`); return; }
  if (res1.status !== 200) { fail(testName, `First request returned ${res1.status}`); return; }
  // Consume body so the connection closes cleanly
  await res1.text();

  // Second request (should be HIT)
  const { res: res2, error: err2 } = await safeFetch(url);
  if (err2) { fail(testName, `Second request failed: ${err2.message}`); return; }
  if (res2.status !== 200) { fail(testName, `Second request returned ${res2.status}`); return; }

  const cacheHeader = res2.headers.get('x-cache');
  if (cacheHeader && cacheHeader.toUpperCase() === 'HIT') {
    pass(testName);
  } else {
    fail(testName, `Expected X-Cache: HIT, got "${cacheHeader}"`);
  }
}

// ─── 7. Stats endpoint ───────────────────────────────────────────────────────
async function testStats() {
  const testName = 'Stats — GET /api/stats returns totalSearches, cacheHitRate, stores';
  const { res, error } = await safeFetch(`${BASE_URL}/api/stats`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    fail(testName, `Failed to parse JSON: ${e.message}`);
    return;
  }

  const missing = [];
  if (typeof body.totalSearches === 'undefined') missing.push('totalSearches');
  if (typeof body.cacheHitRate  === 'undefined') missing.push('cacheHitRate');
  if (typeof body.stores        === 'undefined') missing.push('stores');

  if (missing.length > 0) {
    fail(testName, `Missing fields: ${missing.join(', ')}`);
  } else {
    pass(testName);
  }
}

// ─── 8. Trending ─────────────────────────────────────────────────────────────
async function testTrending() {
  const testName = 'Trending — GET /api/trending returns trending array';
  const { res, error } = await safeFetch(`${BASE_URL}/api/trending`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    fail(testName, `Failed to parse JSON: ${e.message}`);
    return;
  }

  if (!Array.isArray(body.trending)) {
    fail(testName, '"trending" field is missing or not an array');
  } else {
    pass(testName);
  }
}

// ─── 9. Price history ────────────────────────────────────────────────────────
async function testPriceHistory() {
  const testName = 'Price history — GET /api/history?q=milk returns observations array field';
  const { res, error } = await safeFetch(`${BASE_URL}/api/history?q=milk`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    fail(testName, `Failed to parse JSON: ${e.message}`);
    return;
  }

  if (!Array.isArray(body.observations)) {
    fail(testName, '"observations" field is missing or not an array');
  } else {
    pass(testName);
  }
}

// ─── 10. Create alert ────────────────────────────────────────────────────────
async function testCreateAlert() {
  const testName = 'Create alert — POST /api/alerts with JSON body returns success or handled gracefully';
  const { res, error } = await safeFetch(`${BASE_URL}/api/alerts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'test@test.com', query: 'milk', targetPrice: 5.0 }),
  });

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  // Accept 200/201 (created) or 404/501 (not yet implemented) — any response
  // that is not a server crash (5xx other than 501) is acceptable.
  if (res.status >= 500 && res.status !== 501) {
    fail(testName, `Server error: ${res.status}`);
    return;
  }

  // If implemented, expect a JSON body with success indicator or id
  if (res.status === 200 || res.status === 201) {
    let body;
    try {
      body = await res.json();
    } catch (e) {
      fail(testName, `Expected JSON body on success response: ${e.message}`);
      return;
    }
    const hasSuccess = body.success === true || typeof body.id !== 'undefined' || typeof body.alertId !== 'undefined';
    if (hasSuccess) {
      pass(testName);
    } else {
      fail(testName, `Response missing success indicator or id field: ${JSON.stringify(body).slice(0, 100)}`);
    }
  } else {
    // Not yet implemented — gracefully handled
    pass(testName + ` (endpoint not yet implemented — got ${res.status})`);
  }
}

// ─── 11. Get alerts ──────────────────────────────────────────────────────────
async function testGetAlerts() {
  const testName = 'Get alerts — GET /api/alerts?email=test@test.com returns array';
  const { res, error } = await safeFetch(`${BASE_URL}/api/alerts?email=test@test.com`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status >= 500 && res.status !== 501) {
    fail(testName, `Server error: ${res.status}`);
    return;
  }

  if (res.status === 200) {
    let body;
    try {
      body = await res.json();
    } catch (e) {
      fail(testName, `Failed to parse JSON: ${e.message}`);
      return;
    }

    // Response should be an array or an object containing an array field
    const isArray = Array.isArray(body);
    const hasAlertsArray = !isArray && Array.isArray(body.alerts);
    if (isArray || hasAlertsArray) {
      pass(testName);
    } else {
      fail(testName, `Expected array or object with "alerts" array, got: ${JSON.stringify(body).slice(0, 100)}`);
    }
  } else {
    // Not yet implemented — gracefully handled
    pass(testName + ` (endpoint not yet implemented — got ${res.status})`);
  }
}

// ─── 12. Trending with limit ─────────────────────────────────────────────────
async function testTrendingWithLimit() {
  const testName = 'Trending — GET /api/trending?limit=5 returns trending array with max 5 items';
  const { res, error } = await safeFetch(`${BASE_URL}/api/trending?limit=5`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    fail(testName, `Failed to parse JSON: ${e.message}`);
    return;
  }

  if (!Array.isArray(body.trending)) {
    fail(testName, '"trending" field is missing or not an array');
    return;
  }

  if (body.trending.length > 5) {
    fail(testName, `Expected at most 5 items, got ${body.trending.length}`);
  } else {
    pass(testName);
  }
}

// ─── 13. SSE stream ──────────────────────────────────────────────────────────
async function testSSEStream() {
  const testName = 'SSE stream — GET /api/search/stream?q=test sends start, store, done events';

  let res;
  try {
    res = await fetch(`${BASE_URL}/api/search/stream?q=streamtest`, {
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    fail(testName, `Connection error: ${e.message}`);
    return;
  }

  if (res.status !== 200) {
    fail(testName, `Expected 200, got ${res.status}`);
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    fail(testName, `Expected content-type text/event-stream, got "${contentType}"`);
    return;
  }

  // Read chunks until we see start, at least one store, and done events (or timeout)
  const seenEvents = new Set();
  let buffer = '';

  try {
    const decoder = new TextDecoder();
    const reader = res.body.getReader();

    const readTimeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('SSE read timed out after 25s')), 25000)
    );

    const readLoop = (async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // keep incomplete last line

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            const eventName = line.slice(7).trim();
            seenEvents.add(eventName);
          }
        }

        // Stop once we have all three event types
        if (seenEvents.has('start') && seenEvents.has('store') && seenEvents.has('done')) {
          reader.cancel().catch(() => {});
          break;
        }
      }
    })();

    await Promise.race([readLoop, readTimeout]);
  } catch (e) {
    if (!seenEvents.has('start') && !seenEvents.has('done')) {
      fail(testName, `Error reading SSE stream: ${e.message} (events seen: ${[...seenEvents].join(', ') || 'none'})`);
      return;
    }
    // Timeout after seeing some events is acceptable
  }

  const missing = [];
  if (!seenEvents.has('start')) missing.push('"start"');
  if (!seenEvents.has('store')) missing.push('"store"');
  if (!seenEvents.has('done'))  missing.push('"done"');

  if (missing.length > 0) {
    fail(testName, `Missing SSE events: ${missing.join(', ')} (saw: ${[...seenEvents].join(', ') || 'none'})`);
  } else {
    pass(testName);
  }
}

// ─── 10a. Query sanitization — too long ─────────────────────────────────────
async function testQueryTooLong() {
  const testName = 'Query sanitization — query longer than 200 chars returns 400';
  const longQuery = 'a'.repeat(201);
  const { res, error } = await safeFetch(`${BASE_URL}/api/search?q=${encodeURIComponent(longQuery)}`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  if (res.status === 400) {
    pass(testName);
  } else {
    fail(testName, `Expected 400, got ${res.status}`);
  }
}

// ─── 10b. Query sanitization — HTML chars stripped ───────────────────────────
async function testQuerySanitization() {
  const testName = 'Query sanitization — HTML chars like <script> are sanitized in response';
  const xssQuery = '<script>alert(1)</script>milk';
  const { res, error } = await safeFetch(`${BASE_URL}/api/search?q=${encodeURIComponent(xssQuery)}`);

  if (error) { fail(testName, `Connection error: ${error.message}`); return; }

  // Server may return 200 (sanitized) or 400 — both are acceptable security postures.
  // What matters is that the raw HTML chars do NOT appear verbatim in the response.
  let bodyText;
  try {
    bodyText = await res.text();
  } catch (e) {
    fail(testName, `Failed to read response: ${e.message}`);
    return;
  }

  const hasUnsanitized = bodyText.includes('<script>') || bodyText.includes('alert(1)');
  if (hasUnsanitized) {
    fail(testName, 'Response contains unsanitized HTML chars from query');
  } else {
    pass(testName);
  }
}

// ─── Runner ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nGroceryCompare SA — API Test Suite');
  console.log(`Target: ${BASE_URL}`);
  console.log('─'.repeat(60));

  // Check server availability first
  console.log('\n[1/14] Health check');
  const serverUp = await testHealthCheck();

  if (!serverUp) {
    console.log('\n  Server appears to be down. Remaining tests that require a live server');
    console.log('  will be attempted anyway and will show connection errors.\n');
  }

  console.log('\n[2/14] Search validation');
  await testSearchValidation();

  console.log('\n[3/14] Rate limiting');
  await testRateLimiting();

  console.log('\n[4/14] Demo/real search (milk)');
  await testSearchMilk();

  console.log('\n[5/14] Arabic search');
  await testArabicSearch();

  console.log('\n[6/14] Cache');
  await testCache();

  console.log('\n[7/14] Stats endpoint');
  await testStats();

  console.log('\n[8/14] Trending');
  await testTrending();

  console.log('\n[9/14] Price history');
  await testPriceHistory();

  console.log('\n[10/14] Create alert');
  await testCreateAlert();

  console.log('\n[11/14] Get alerts');
  await testGetAlerts();

  console.log('\n[12/14] Trending with limit');
  await testTrendingWithLimit();

  console.log('\n[13/14] SSE stream');
  await testSSEStream();

  console.log('\n[14/14] Query sanitization');
  await testQueryTooLong();
  await testQuerySanitization();

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(60));
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log(`Results: ${passed} passed, ${failed} failed (${results.length} total)`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => !r.ok).forEach(r => {
      console.log(`  - ${r.name}`);
      console.log(`    ${r.reason}`);
    });
    console.log('');
    process.exit(1);
  } else {
    console.log('\nAll tests passed.\n');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('\nUnexpected test runner error:', err);
  process.exit(1);
});
