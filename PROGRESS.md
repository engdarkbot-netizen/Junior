# Session Progress Log
Last updated: 2026-03-19

---

## What We're Trying to Do
Get the Saudi grocery price comparison app (https://junior-production-890c.up.railway.app) working with real product data from Saudi stores.

The app runs on Railway (US datacenter). Saudi stores block non-Saudi IPs, so we need a proxy in Saudi Arabia (or at least a Saudi-located server) to scrape them.

---

## Proxy Setup

- **EC2 Instance:** `16.24.141.53` (AWS, region unknown)
- **Proxy URL:** `http://16.24.141.53:3128` (Squid)
- **Set in Railway env var:** `PROXY_URL=http://16.24.141.53:3128`
- **Squid status:** Running ✅ (`sudo systemctl status squid` → active)
- **Squid config:** `/etc/squid/squid.conf` — has `http_access allow all` on line 3

### Proxy Test Endpoint
```
https://junior-production-890c.up.railway.app/api/test-proxy
```
**Current result:** FAILING — Railway cannot reach EC2 port 3128

### What We Know
- Proxy works from Mac: `curl -x http://16.24.141.53:3128 "https://api.ipify.org/?format=json"` ✅
- Railway requests never appear in Squid access log → TCP connection not reaching Squid
- EC2 iptables shows ACCEPT for port 3128 from `0.0.0.0/0` (5 rules)
- UFW is inactive

### Most Likely Cause (NOT YET FIXED)
**VPC Network ACL** is blocking Railway's traffic at the subnet level.
- NACLs are stateless — need BOTH inbound (port 3128) AND outbound (ephemeral ports 1024-65535) rules
- Check: AWS Console → VPC → Subnets → your subnet → Network ACL tab

### Next Step When You Return
1. Check VPC Network ACL outbound rules — add TCP 1024-65535 → `0.0.0.0/0` if missing
2. Run `sudo iptables -L INPUT -n --line-numbers` on EC2 to see full chain
3. After fixing, hit `/api/test-proxy` — should return `{"ok":true,...}`

---

## Store API Endpoint Research (Completed)

Research agent confirmed platforms for each store. Already pushed fixes to production.

| Store | Platform | API Status |
|-------|----------|------------|
| Tamimi | ZopSmart (confirmed) | Updated to `shop.tamimimarkets.com` ZopSmart API patterns |
| LuLu | Oracle CX Commerce | Updated to `/ccstore/v1/search` (was `/ccstoreui/`, 403) |
| Carrefour KSA | SAP Commerce Cloud (confirmed) | Needs OAuth client_credentials token — find `client_id`/`client_secret` from browser DevTools on carrefourksa.com |
| Othaim | Custom/corporate site only | Removed broken API — browser scrape only |
| Panda | Custom/Oracle (unconfirmed) | Added Referer + User-Agent headers to reduce 429s |
| BinDawood | Shopify | Working ✅ |
| Noon | Unknown | Needs proxy |
| Danube | Unknown | Needs proxy |

### Carrefour — TODO (when proxy works)
SAP Commerce OCC v2 requires OAuth Bearer token:
1. Open DevTools on carrefourksa.com → Network tab → look for POST to `/authorizationserver/oauth/token`
2. Grab `client_id` and `client_secret` from that request
3. Add to server.js store config

---

## Git Branch
- **Production branch:** `claude/production-dKt6N`
- **Deploy URL:** https://junior-production-890c.up.railway.app
- Every push to `claude/production-dKt6N` triggers Railway redeploy (~2 min)

---

## Key Files
- `server.js` — main app, store configs around line 1224, scrapeStore() at line 1280
- `PROXY_URL` env var set in Railway dashboard
- `/api/test-proxy` — proxy health check endpoint
- `/api/ping` — basic uptime check

---

## EC2 SSH
```bash
# User has SSH access as 'ubuntu'
ssh ubuntu@16.24.141.53
```
Squid config: `/etc/squid/squid.conf`
Squid logs: `/var/log/squid/access.log`
