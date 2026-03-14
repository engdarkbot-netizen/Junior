/**
 * GroceryCompare SA — AI Test Agent
 *
 * Uses Claude Opus 4.6 with tool use to test the website, find issues,
 * and produce a structured report.
 *
 * Usage:
 *   BASE_URL=https://your-app.up.railway.app ANTHROPIC_API_KEY=sk-... node test-agent.js
 *
 * Optional env vars:
 *   TEST_QUERIES   - Comma-separated search terms to test (default: a built-in list)
 *   BASE_URL       - Railway / local URL (default: http://localhost:3000)
 */

import Anthropic from '@anthropic-ai/sdk';

const BASE_URL   = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const API_KEY    = process.env.ANTHROPIC_API_KEY;
const TEST_QUERIES = process.env.TEST_QUERIES
  ? process.env.TEST_QUERIES.split(',').map(q => q.trim())
  : ['لبن كفير', 'خبز', 'عصير برتقال', 'rice', 'milk'];

if (!API_KEY) {
  console.error('ERROR: Set ANTHROPIC_API_KEY environment variable');
  process.exit(1);
}

/* ─── HTTP helpers ─────────────────────────────────────────────── */
async function httpGet(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (_) {}
    return { ok: res.ok, status: res.status, body, json };
  } catch (err) {
    return { ok: false, status: 0, body: err.message, json: null };
  } finally {
    clearTimeout(timer);
  }
}

/* ─── Tool definitions ─────────────────────────────────────────── */
const tools = [
  {
    name: 'check_health',
    description: 'Check the /api/health endpoint. Returns server uptime, memory, browser status, and proxy config.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'search_products',
    description: 'Call /api/search?q=<query> and return the result. Use this to test that search works for a given Arabic or English query.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query (Arabic or English)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_logs',
    description: 'Retrieve the most recent server logs from /api/logs. Use this to diagnose errors.',
    input_schema: {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'How many recent log lines to fetch (max 200, default 50)' },
      },
      required: [],
    },
  },
  {
    name: 'report_issue',
    description: 'Record a confirmed issue found during testing. Call this once per distinct problem.',
    input_schema: {
      type: 'object',
      properties: {
        severity:    { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: 'How severe is the issue' },
        title:       { type: 'string', description: 'Short one-line title' },
        description: { type: 'string', description: 'What is wrong and how it was detected' },
        suggestion:  { type: 'string', description: 'How to fix it' },
      },
      required: ['severity', 'title', 'description', 'suggestion'],
    },
  },
];

/* ─── Tool executor ────────────────────────────────────────────── */
const issues = [];

async function executeTool(name, input) {
  switch (name) {
    case 'check_health': {
      const r = await httpGet(`${BASE_URL}/api/health`);
      return JSON.stringify({ httpStatus: r.status, data: r.json || r.body });
    }
    case 'search_products': {
      const url = `${BASE_URL}/api/search?q=${encodeURIComponent(input.query)}`;
      const r   = await httpGet(url, 40000);
      if (!r.json) return JSON.stringify({ httpStatus: r.status, error: r.body.slice(0, 500) });
      // Summarise to keep tokens low
      const summary = {
        httpStatus: r.status,
        query: r.json.query,
        timestamp: r.json.timestamp,
        stores: (r.json.stores || []).map(s => ({
          id:           s.id,
          name:         s.name,
          productCount: (s.products || []).length,
          error:        s.error || null,
          topProduct:   s.products?.[0] ? { name: s.products[0].name, price: s.products[0].price } : null,
        })),
      };
      return JSON.stringify(summary);
    }
    case 'get_logs': {
      const n = input.n || 50;
      const r = await httpGet(`${BASE_URL}/api/logs?n=${n}`);
      return JSON.stringify({ httpStatus: r.status, data: r.json || r.body });
    }
    case 'report_issue': {
      issues.push(input);
      return JSON.stringify({ recorded: true, totalIssues: issues.length });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

/* ─── Agent loop ───────────────────────────────────────────────── */
async function runAgent() {
  const client = new Anthropic({ apiKey: API_KEY });

  const systemPrompt = `You are a QA engineer testing GroceryCompare SA — a grocery price comparison website for Saudi Arabia.
The website is at: ${BASE_URL}
Test queries to run: ${TEST_QUERIES.join(', ')}

Your job:
1. Call check_health to verify the server is running correctly.
2. Run search_products for EVERY query in the test list above.
3. If you see errors or 0-product results, call get_logs to investigate.
4. For each confirmed problem, call report_issue with severity, title, description, and a concrete fix suggestion.
5. After all tests are done, write a final summary report in markdown.

Be thorough. Check: HTTP status codes, browser errors, missing products, slow responses, store-specific failures.`;

  const messages = [
    {
      role: 'user',
      content: `Please test the website now. Run all ${TEST_QUERIES.length} search queries, check health, investigate any errors, file issues, and give me a final markdown report.`,
    },
  ];

  console.log(`\n🤖  GroceryCompare Test Agent`);
  console.log(`📡  Testing: ${BASE_URL}`);
  console.log(`🔍  Queries: ${TEST_QUERIES.join(', ')}\n`);
  console.log('─'.repeat(60));

  let iterations = 0;
  const MAX_ITERATIONS = 30;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stream = client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system: systemPrompt,
      tools,
      messages,
    });

    // Stream text output as it arrives
    stream.on('text', (delta) => process.stdout.write(delta));

    const message = await stream.finalMessage();

    if (message.stop_reason === 'end_turn') {
      console.log('\n' + '─'.repeat(60));
      break;
    }

    if (message.stop_reason !== 'tool_use') {
      console.log(`\nUnexpected stop_reason: ${message.stop_reason}`);
      break;
    }

    // Append assistant turn
    messages.push({ role: 'assistant', content: message.content });

    // Execute all tool calls
    const toolResults = [];
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      console.log(`\n🔧  [${block.name}] ${JSON.stringify(block.input)}`);
      const result = await executeTool(block.name, block.input);
      const preview = result.length > 300 ? result.slice(0, 300) + '…' : result;
      console.log(`    → ${preview}`);
      toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  /* ─── Print issue summary ───────────────────────────────────── */
  if (issues.length > 0) {
    console.log('\n\n📋  ISSUES FOUND\n' + '─'.repeat(60));
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);
    issues.forEach((issue, i) => {
      const icon = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' }[issue.severity];
      console.log(`\n${i + 1}. ${icon} [${issue.severity.toUpperCase()}] ${issue.title}`);
      console.log(`   Problem:    ${issue.description}`);
      console.log(`   Fix:        ${issue.suggestion}`);
    });
  } else {
    console.log('\n✅  No issues found!');
  }

  console.log(`\n✔  Agent finished (${iterations} iterations, ${issues.length} issue(s) filed)\n`);
  return issues;
}

runAgent().catch(err => {
  console.error('Agent error:', err.message);
  process.exit(1);
});
