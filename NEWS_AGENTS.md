# News Agents

Two AI agents built on the Claude API that gather live news via web search and
produce dated markdown briefings.

| Agent | Script | Report |
|-------|--------|--------|
| 🧠 Daily AI News | `ai-news-agent.mjs` | `reports/ai-news-YYYY-MM-DD.md` |
| 📈 Saudi Stock Market (Tadawul) | `saudi-stocks-agent.mjs` | `reports/saudi-stocks-YYYY-MM-DD.md` |

Both agents share a common runner (`news-agent-core.mjs`) that streams the
briefing to the console as it's written and saves the final markdown report.

## What each agent covers

**AI News Agent** — model/product releases, research breakthroughs, funding and
business news, policy/regulation, and developer tooling. Output: TL;DR, top
stories with sources, and a "Worth Watching" section.

**Saudi Stocks Agent** — TASI market summary, top movers with tickers, company
news (earnings, dividends, contracts), IPOs on the main market and Nomu, CMA /
Saudi Exchange regulatory announcements, and macro context (oil, Vision 2030,
PIF). Searches are geo-targeted to Saudi Arabia and aware of the
Sunday–Thursday trading week.

## Run locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...

npm run news:ai      # AI news briefing
npm run news:saudi   # Saudi stocks briefing
npm run news         # both
```

### Configuration (env vars)

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — (required) | Anthropic API key |
| `NEWS_MODEL` | `claude-opus-4-8` | Claude model to use |
| `MAX_SEARCHES` | `8` | Max web searches per run |
| `OUTPUT_DIR` | `./reports` | Where markdown reports are written |

## Daily automation

`.github/workflows/daily-news.yml` runs both agents every day at 07:00 Riyadh
time (04:00 UTC) and uploads the reports as workflow artifacts (kept 30 days).
It can also be triggered manually from the Actions tab.

**Setup:** add `ANTHROPIC_API_KEY` as a repository secret
(Settings → Secrets and variables → Actions → New repository secret).

## Notes

- Web search is a server-side Claude tool — no scraping code or news API keys
  are needed; each search costs $10 per 1,000 searches plus normal token usage.
- Reports are gitignored locally; the workflow publishes them as artifacts.
- Every claim in a briefing includes a source link, and the agents are
  instructed to skip sections with no real news rather than pad.
