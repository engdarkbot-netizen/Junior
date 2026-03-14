/**
 * GroceryCompare SA — Claude AI Test Agent
 *
 * Uses Claude Opus 4.6 with adaptive thinking to test the live website,
 * find bugs, measure performance, and produce a structured report.
 *
 * Usage:
 *   BASE_URL=https://your-app.up.railway.app \
 *   ANTHROPIC_API_KEY=sk-ant-...              \
 *   node test-agent.mjs
 *
 * Optional env vars:
 *   TEST_QUERIES  - Comma-separated queries (default: built-in Arabic+English list)
 *   VERBOSE       - Set to "1" to print raw tool results
 */

import Anthropic from '@anthropic-ai/sdk';

/* ── Config ──────────────────────────────────────────────────── */
const BASE_URL = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY  = process.env.ANTHROPIC_API_KEY;
const VERBOSE  = process.env.VERBOSE === '1';
const TIMEOUT  = 45_000;

const TEST_QUERIES = process.env.TEST_QUERIES
  ? process.env.TEST_QUERIES.split(',').map(q => q.trim())
  : ['حليب', 'أرز', 'بيض', 'milk', 'rice', 'water'];

if (!API_KEY) {
  console.error('\n  ERROR: Set ANTHROPIC_API_KEY environment variable\n');
  process.exit(1);
}

/* ── HTTP helper ─────────────────────────────────────────────── */
async function httpGet(url, timeoutMs = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res  = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    const ms   = Math.round(performance.now() - t0);
    let json = null;
    try { json = JSON.parse(body); } catch (_) {}
    return { ok: res.ok, status: res.status, ms, body: body.slice(0, 4000), json,
             headers: Object.fromEntries(res.headers.entries()) };
  } catch (err) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0),
             body: err.message, json: null, headers: {} };
  } finally {
    clearTimeout(timer);
  }
}

/* ── SSE helper ──────────────────────────────────────────────── */
async function testSSE(query, timeoutMs = TIMEOUT) {
  const url = `${BASE_URL}/api/search/stream?q=${encodeURIComponent(query)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  const events = [];
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    });
    if (!res.ok) return { ok: false, status: res.status, events: [], ms: 0 };

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let curEvent = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('event: ')) { curEvent = line.slice(7).trim(); continue; }
        if (line.startsWith('data: ') && curEvent) {
          try { events.push({ event: curEvent, data: JSON.parse(line.slice(6)) }); }
          catch (_) {}
          if (curEvent === 'done') { reader.cancel(); break; }
          curEvent = null;
        }
      }
      if (events.find(e => e.event === 'done')) break;
    }
    return { ok: true, status: 200, events, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { ok: false, status: 0, events, ms: Math.round(performance.now() - t0), error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ── Tool definitions ────────────────────────────────────────── */
const tools = [
  {
    name: 'check_health',
    description: 'Check /api/health. Returns uptime, memory, browser state, proxy, and store list.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_products',
    description: 'Call GET /api/search?q=<query>. Returns summary of products per store, response time, cache status.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'test_cache',
    description: 'Call /api/search twice for the same query. Verifies X-Cache: HIT on second call and measures speedup.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'test_sse_stream',
    description: 'Test /api/search/stream SSE endpoint. Returns events received, timing, and per-store results.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'test_rate_limit',
    description: 'Send 25 rapid requests to verify rate limiting kicks in with 429 after 20.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_logs',
    description: 'Fetch recent server logs from /api/logs to diagnose errors.',
    input_schema: {
      type: 'object',
      properties: { n: { type: 'number', description: 'Lines to fetch (default 60, max 200)' } },
      required: [],
    },
  },
  {
    name: 'report_issue',
    description: 'Record a confirmed bug or problem.',
    input_schema: {
      type: 'object',
      properties: {
        severity:    { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        title:       { type: 'string' },
        description: { type: 'string' },
        suggestion:  { type: 'string' },
      },
      required: ['severity', 'title', 'description', 'suggestion'],
    },
  },
  {
    name: 'report_metric',
    description: 'Record a performance or quality metric.',
    input_schema: {
      type: 'object',
      properties: {
        name:   { type: 'string' },
        value:  { type: 'string' },
        status: { type: 'string', enum: ['good', 'warn', 'bad'] },
      },
      required: ['name', 'value', 'status'],
    },
  },
];

/* ── Tool executor ───────────────────────────────────────────── */
const issues  = [];
const metrics = [];

async function executeTool(name, input) {
  switch (name) {

    case 'check_health': {
      const r = await httpGet(`${BASE_URL}/api/health`, 8000);
      return JSON.stringify({ httpStatus: r.status, ms: r.ms, data: r.json || r.body });
    }

    case 'search_products': {
      const url = `${BASE_URL}/api/search?q=${encodeURIComponent(input.query)}`;
      const r   = await httpGet(url);
      if (!r.json) return JSON.stringify({ httpStatus: r.status, ms: r.ms, error: r.body });
      return JSON.stringify({
        httpStatus:  r.status, ms: r.ms,
        cache:       r.headers['x-cache'] || 'unknown',
        cacheAge:    r.headers['x-cache-age'] || null,
        query:       r.json.query,
        totalProducts: (r.json.stores || []).reduce((n, s) => n + (s.products?.length || 0), 0),
        storesWithErrors: (r.json.stores || []).filter(s => s.error).length,
        stores: (r.json.stores || []).map(s => ({
          id: s.id, name: s.name,
          productCount: (s.products || []).length,
          error: s.error || null,
          topProduct: s.products?.[0]
            ? { name: s.products[0].name?.slice(0, 60), price: s.products[0].price }
            : null,
        })),
      });
    }

    case 'test_cache': {
      const url = `${BASE_URL}/api/search?q=${encodeURIComponent(input.query)}`;
      const r1  = await httpGet(url);
      const r2  = await httpGet(url);
      return JSON.stringify({
        first:        { ms: r1.ms, cache: r1.headers['x-cache'] },
        second:       { ms: r2.ms, cache: r2.headers['x-cache'], age: r2.headers['x-cache-age'] },
        cacheWorking: r2.headers['x-cache'] === 'HIT',
        speedupPct:   r1.ms > 0 ? Math.round((1 - r2.ms / r1.ms) * 100) : 0,
      });
    }

    case 'test_sse_stream': {
      const r = await testSSE(input.query);
      const storeEvents = r.events.filter(e => e.event === 'store');
      return JSON.stringify({
        ok: r.ok, ms: r.ms,
        totalEvents: r.events.length,
        storesReceived: storeEvents.length,
        doneReceived: !!r.events.find(e => e.event === 'done'),
        stores: storeEvents.map(e => ({
          id: e.data.id, productCount: e.data.products?.length || 0, hasError: !!e.data.error,
        })),
        error: r.error || null,
      });
    }

    case 'test_rate_limit': {
      const url     = `${BASE_URL}/api/search?q=ratelimit_test`;
      const results = await Promise.all(
        Array.from({ length: 25 }, () => httpGet(url, 5000).then(r => r.status))
      );
      const hits429 = results.filter(s => s === 429).length;
      const hits200 = results.filter(s => s === 200).length;
      return JSON.stringify({ total: 25, status200: hits200, status429: hits429, rateLimitWorking: hits429 > 0 });
    }

    case 'get_logs': {
      const n = Math.min(input.n || 60, 200);
      const r = await httpGet(`${BASE_URL}/api/logs?n=${n}`, 5000);
      if (!r.json) return JSON.stringify({ httpStatus: r.status, error: r.body });
      const logs   = r.json.logs || [];
      const errors = logs.filter(l => l.level === 'error');
      return JSON.stringify({
        httpStatus: r.status, total: logs.length, errors: errors.length,
        recentErrors: errors.slice(-5).map(l => ({ ts: l.ts, msg: l.msg.slice(0, 200) })),
        recentInfo:   logs.filter(l => l.level === 'info').slice(-3).map(l => l.msg.slice(0, 120)),
      });
    }

    case 'report_issue':  { issues.push(input);  return JSON.stringify({ recorded: true, total: issues.length }); }
    case 'report_metric': { metrics.push(input); return JSON.stringify({ recorded: true, total: metrics.length }); }
    default: return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/* ── Agent loop ──────────────────────────────────────────────── */
async function runAgent() {
  const client = new Anthropic({ apiKey: API_KEY });

  const systemPrompt = `You are a senior QA engineer testing GroceryCompare SA.
The site is live at: ${BASE_URL}
Test queries: ${TEST_QUERIES.join(', ')}

Checklist (complete all steps):
1. check_health → verify server health
2. search_products for EVERY query in the list
3. test_cache on any one query
4. test_sse_stream on any one query
5. test_rate_limit
6. get_logs → look for recurring errors
7. report_issue for each confirmed bug
8. report_metric for key numbers (response time, hit rate, cache speedup, rate limit)
9. Write a final markdown report: Executive Summary | Issues | Metrics | Recommendations

Be thorough and critical.`;

  const messages = [{
    role: 'user',
    content: `Run the full test suite on ${TEST_QUERIES.length} queries, check all systems, report issues and metrics, then give me a final markdown report.`,
  }];

  const LINE = '─'.repeat(64);
  console.log(`\n${LINE}`);
  console.log(`  🤖  GroceryCompare SA — AI Test Agent`);
  console.log(`  📡  ${BASE_URL}`);
  console.log(`  🔍  ${TEST_QUERIES.join(', ')}`);
  console.log(`  📅  ${new Date().toLocaleString()}`);
  console.log(`${LINE}\n`);

  let iter = 0;
  while (iter++ < 40) {
    const stream = client.messages.stream({
      model: 'claude-opus-4-6', max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: systemPrompt, tools, messages,
    });
    stream.on('text', d => process.stdout.write(d));
    const message = await stream.finalMessage();

    if (message.stop_reason === 'end_turn') { console.log(`\n${LINE}`); break; }
    if (message.stop_reason !== 'tool_use')  break;

    messages.push({ role: 'assistant', content: message.content });

    const toolResults = [];
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`\n  🔧 [${block.name}] ${JSON.stringify(block.input)}`);
      const result  = await executeTool(block.name, block.input);
      const preview = VERBOSE ? result : (result.length > 400 ? result.slice(0, 400) + '…' : result);
      console.log(`     → ${preview}`);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  /* ── Summary ── */
  const ICON = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
  const SORD = { critical: 0, high: 1, medium: 2, low: 3 };
  const MICON = { good: '✅', warn: '⚠️', bad: '❌' };

  if (issues.length) {
    console.log(`\n${LINE}\n  📋 ISSUES (${issues.length})\n${LINE}`);
    [...issues].sort((a, b) => SORD[a.severity] - SORD[b.severity]).forEach((iss, i) => {
      console.log(`\n  ${i+1}. ${ICON[iss.severity]} [${iss.severity.toUpperCase()}] ${iss.title}`);
      console.log(`     Problem: ${iss.description}`);
      console.log(`     Fix:     ${iss.suggestion}`);
    });
  }
  if (metrics.length) {
    console.log(`\n${LINE}\n  📊 METRICS (${metrics.length})\n${LINE}`);
    metrics.forEach(m => console.log(`  ${MICON[m.status]}  ${m.name}: ${m.value}`));
  }

  console.log(`\n${LINE}`);
  console.log(`  ✔  Done — ${iter} iterations · ${issues.length} issue(s) · ${metrics.length} metric(s)`);
  console.log(`${LINE}\n`);
}

runAgent().catch(err => { console.error('Agent error:', err.message); process.exit(1); });
