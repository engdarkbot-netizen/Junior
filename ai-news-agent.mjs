/**
 * Daily AI News Agent
 *
 * Searches the web for today's most important AI news and produces a
 * markdown digest (saved to ./reports/ai-news-YYYY-MM-DD.md).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node ai-news-agent.mjs
 *
 * Optional env vars: NEWS_MODEL, MAX_SEARCHES, OUTPUT_DIR (see news-agent-core.mjs)
 */

import { runNewsAgent } from './news-agent-core.mjs';

const today = new Date().toISOString().slice(0, 10);

const system = `You are an AI industry news analyst producing a daily briefing.
Today's date is ${today}.

For questions where current information would change the answer, search before
answering rather than answering from memory. Prioritize news from the last 24-48
hours. Cross-check anything surprising against a second source before including it.

Coverage areas, in priority order:
1. Major model / product releases (Anthropic, OpenAI, Google, Meta, Mistral, xAI, open-source)
2. AI research breakthroughs and notable papers
3. Business news: funding rounds, acquisitions, partnerships, chip/compute supply
4. Policy and regulation (EU AI Act, US executive actions, safety commitments)
5. Notable tools and developer ecosystem updates

Output format (markdown):
- Start with a "TL;DR" section: 3-5 bullet points of the day's biggest stories
- Then "Top Stories": each with a bold headline, 2-3 sentence summary, and source link
- Then short sections for the remaining coverage areas that have news today
- End with "Worth Watching": 1-3 developing stories to track
- Every claim must include a source link. Skip a section entirely if nothing
  meaningful happened in it today - do not pad.`;

const prompt = `Produce today's AI news briefing (${today}). Search for the latest
AI news across the coverage areas, then write the full markdown digest.`;

runNewsAgent({
  title: 'Daily AI News Briefing',
  emoji: '🧠',
  slug: 'ai-news',
  system,
  prompt,
}).catch(err => { console.error('Agent error:', err.message); process.exit(1); });
