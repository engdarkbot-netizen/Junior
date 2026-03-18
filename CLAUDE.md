# Project Instructions

## Git Workflow

- **Always push to `claude/production-dKt6N`** — this is the Railway deployment branch.
- Every push triggers a live redeploy at: https://junior-production-890c.up.railway.app
- Never push to `master`, `main`, or other `claude/*` branches unless explicitly told.
- Use: `git push -u origin claude/production-dKt6N`

## Testing

- After each push, wait ~2 min for Railway to redeploy, then test the live URL.
- Production URL: https://junior-production-890c.up.railway.app
