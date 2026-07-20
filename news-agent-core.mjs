/**
 * Shared runner for the news agents (ai-news-agent.mjs / saudi-stocks-agent.mjs).
 *
 * Uses Claude with the server-side web_search tool to gather live news,
 * streams the digest to the console, and saves a dated markdown report.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY - Anthropic API key
 *
 * Optional env vars:
 *   NEWS_MODEL   - Claude model ID (default: claude-opus-4-8)
 *   MAX_SEARCHES - Max web searches per run (default: 8)
 *   OUTPUT_DIR   - Where reports are written (default: ./reports)
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const API_KEY      = process.env.ANTHROPIC_API_KEY;
const MODEL        = process.env.NEWS_MODEL || 'claude-opus-4-8';
const MAX_SEARCHES = Number(process.env.MAX_SEARCHES || 8);
const OUTPUT_DIR   = process.env.OUTPUT_DIR || './reports';
const MAX_TURNS    = 10; // safety cap on pause_turn continuations

const LINE = '─'.repeat(64);

export async function runNewsAgent({ title, emoji, slug, system, prompt, userLocation }) {
  if (!API_KEY) {
    console.error('\n  ERROR: Set ANTHROPIC_API_KEY environment variable\n');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey: API_KEY });
  const today  = new Date().toISOString().slice(0, 10);

  const webSearchTool = {
    type: 'web_search_20260209',
    name: 'web_search',
    max_uses: MAX_SEARCHES,
    ...(userLocation ? { user_location: userLocation } : {}),
  };

  console.log(`\n${LINE}`);
  console.log(`  ${emoji}  ${title}`);
  console.log(`  🤖  ${MODEL} · up to ${MAX_SEARCHES} web searches`);
  console.log(`  📅  ${today}`);
  console.log(`${LINE}\n`);

  const messages = [{ role: 'user', content: prompt }];
  let message = null;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: 'adaptive' },
      system,
      tools: [webSearchTool],
      messages,
    });

    stream.on('text', d => process.stdout.write(d));
    message = await stream.finalMessage();

    // Server-side tool loop hit its iteration limit — resume where it left off
    if (message.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: message.content });
      continue;
    }
    break;
  }

  const digest = (message?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  if (!digest.trim()) {
    console.error(`\n  ERROR: No digest produced (stop_reason: ${message?.stop_reason})\n`);
    process.exit(1);
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, `${slug}-${today}.md`);
  fs.writeFileSync(outPath, `# ${title} — ${today}\n\n${digest}\n`);

  const searches = (message.content || []).filter(b => b.type === 'server_tool_use').length;
  console.log(`\n\n${LINE}`);
  console.log(`  ✔  Report saved: ${outPath}`);
  console.log(`  🔍  Searches this turn: ${searches} · tokens out: ${message.usage.output_tokens}`);
  console.log(`${LINE}\n`);

  return { outPath, digest };
}
