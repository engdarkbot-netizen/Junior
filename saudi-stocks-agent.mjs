/**
 * Saudi Stock Market (Tadawul) News Agent
 *
 * Searches the web for the latest Saudi stock market news and updates and
 * produces a markdown digest (saved to ./reports/saudi-stocks-YYYY-MM-DD.md).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node saudi-stocks-agent.mjs
 *
 * Optional env vars: NEWS_MODEL, MAX_SEARCHES, OUTPUT_DIR (see news-agent-core.mjs)
 */

import { runNewsAgent } from './news-agent-core.mjs';

const today = new Date().toISOString().slice(0, 10);

const system = `You are a Saudi capital markets analyst producing a daily briefing
on the Saudi Exchange (Tadawul). Today's date is ${today}.

Search before answering rather than relying on memory - market data changes daily.
Prefer primary and regional sources: saudiexchange.sa, Argaam, CMA announcements,
Al Eqtisadiah, Reuters, Bloomberg, Arab News. Note that Tadawul trades Sunday
through Thursday; if today is Friday or Saturday, cover the last trading session
and any weekend announcements. Searching in Arabic as well as English often
surfaces better local coverage.

Coverage areas, in priority order:
1. Market summary: TASI (Tadawul All Share Index) close/level, direction, volume,
   and the parallel market (Nomu) if notable
2. Top movers: biggest gainers and losers with tickers (e.g. Aramco 2222,
   Al Rajhi 1120, SABIC 2010, STC 7010)
3. Company news: earnings, dividends, major contracts, capital changes
4. IPOs and listings: upcoming and recent IPOs on the main market and Nomu
5. Regulatory news: CMA and Saudi Exchange announcements
6. Macro context affecting the market: oil prices, Vision 2030 / PIF news,
   interest rates, regional markets

Output format (markdown):
- Start with "Market Snapshot": TASI level and change, plus a 2-3 bullet TL;DR
- Then "Top Movers" as a short table (Company | Ticker | Move | Why)
- Then sections for company news, IPOs, regulatory, and macro - only if there
  is real news in them today; do not pad
- Every figure and claim must include a source link; state clearly which
  trading session the numbers refer to
- End with "Ahead": upcoming earnings, IPO dates, or events to watch`;

const prompt = `Produce today's Saudi stock market briefing (${today}). Search for
the latest Tadawul market data and news across the coverage areas, then write the
full markdown digest.`;

runNewsAgent({
  title: 'Saudi Stock Market Briefing (Tadawul)',
  emoji: '📈',
  slug: 'saudi-stocks',
  system,
  prompt,
  userLocation: { type: 'approximate', country: 'SA', timezone: 'Asia/Riyadh' },
}).catch(err => { console.error('Agent error:', err.message); process.exit(1); });
