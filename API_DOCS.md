# GroceryCompare SA — API Reference

Base URL: `http://localhost:3000` (or your deployed host)

All endpoints return JSON unless noted. Rate limit: 20 requests/minute per IP (returns `429` when exceeded).

---

## GET /api/health

Returns server health status, browser connection state, and configured stores.

**Response**
```json
{
  "status": "ok",
  "uptime": 142.3,
  "memory": { "rss": 80000000, "heapUsed": 45000000 },
  "browser": "unavailable (demo mode)",
  "demo": true,
  "demoReason": "Playwright not available",
  "stores": ["panda", "carrefour", "danube", "tamimi", "lulu"],
  "proxy": "none",
  "timestamp": "2026-03-14T10:00:00.000Z"
}
```

---

## GET /api/search?q=

Search for a product across all configured stores. Supports Arabic and English queries. Results are cached; a second identical request returns `X-Cache: HIT`.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` | Yes | Product search term (max 200 chars) |

**Responses**

- `400` — missing or too-long query
- `200` — search results

```json
{
  "query": "milk",
  "normalizedQuery": "milk",
  "demo": true,
  "stores": [
    {
      "id": "panda",
      "name": "Panda",
      "products": [
        { "name": "Full Cream Milk 1L", "price": 4.5, "unit": "1L", "url": "https://..." }
      ],
      "scrapedAt": "2026-03-14T10:00:00.000Z"
    }
  ]
}
```

---

## GET /api/search/stream?q=

Server-Sent Events (SSE) stream of search results. Each store result is emitted as it becomes available.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` | Yes | Product search term (max 200 chars) |

**Content-Type:** `text/event-stream`

**Events**

| Event | Payload |
|-------|---------|
| `start` | `{ "query": "milk", "stores": 5 }` |
| `store` | `{ "id": "panda", "name": "Panda", "products": [...] }` |
| `done` | `{ "totalMs": 3200 }` |
| `error` | `{ "message": "..." }` |

---

## GET /api/stats

Returns aggregate analytics: search counts, cache performance, per-store success rates, and current demo mode state.

**Response**
```json
{
  "uptime": 600,
  "startedAt": "2026-03-14T09:50:00.000Z",
  "totalSearches": 42,
  "cacheHits": 18,
  "cacheMisses": 24,
  "cacheHitRate": "42.9%",
  "cacheSize": 10,
  "avgResponseMs": 1850,
  "uniqueQueries": 15,
  "demoMode": true,
  "demoReason": "Playwright not available",
  "alertsCount": 3,
  "priceHistoryQueries": 8,
  "recentErrors": [],
  "topQueries": [{ "query": "milk", "count": 12, "lastSearched": "2026-03-14T10:00:00.000Z" }],
  "stores": {
    "panda": { "success": 20, "fail": 2, "totalProducts": 60, "successRate": "90.9%", "avgProducts": "3.0" }
  }
}
```

---

## GET /api/trending?limit=

Returns the most-searched queries sorted by frequency.

**Query parameters**

| Parameter | Required | Default | Max |
|-----------|----------|---------|-----|
| `limit` | No | `10` | `20` |

**Response**
```json
{
  "trending": [
    { "query": "milk", "count": 12, "lastSearched": "2026-03-14T10:00:00.000Z" }
  ],
  "total": 42
}
```

---

## GET /api/history?q=

Returns the last 10 price observations recorded for a query.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` | Yes | Product search term |

**Responses**

- `400` — missing query
- `200` — history result

```json
{
  "query": "milk",
  "normalizedQuery": "milk",
  "observations": [
    { "storeId": "panda", "price": 4.5, "recordedAt": "2026-03-14T09:00:00.000Z" }
  ]
}
```

---

## POST /api/alerts

Create a price alert. Sends a notification when the product price drops below `targetPrice`. Maximum 5 alerts per email address.

**Request body (JSON)**
```json
{
  "email": "user@example.com",
  "query": "milk",
  "targetPrice": 4.0
}
```

**Responses**

- `400` — invalid email, missing query, or non-positive targetPrice; also returned when 5-alert limit is reached
- `201` — alert created

```json
{
  "success": true,
  "alertId": "user@example.com:milk",
  "alert": {
    "email": "user@example.com",
    "query": "milk",
    "targetPrice": 4.0,
    "createdAt": "2026-03-14T10:00:00.000Z"
  }
}
```

---

## GET /api/alerts?email=

List all active price alerts for an email address.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `email` | Yes | Email address (must contain `@`) |

**Responses**

- `400` — missing or invalid email
- `200` — list of alerts

```json
{
  "email": "user@example.com",
  "alerts": [
    { "email": "user@example.com", "query": "milk", "targetPrice": 4.0, "createdAt": "2026-03-14T10:00:00.000Z" }
  ]
}
```

---

## GET /api/basket?q=

Compare total basket cost across stores for multiple items. Pass multiple `q` values (up to 10). Results are sorted by fewest missing items, then lowest total.

**Query parameters**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `q` | Yes | One or more product search terms (repeat for each item) |

**Responses**

- `400` — missing queries or more than 10 items
- `200` — per-store basket totals

```json
{
  "queries": ["milk", "bread"],
  "stores": [
    {
      "id": "panda",
      "name": "Panda",
      "items": [
        { "query": "milk", "product": { "name": "Full Cream Milk 1L", "price": 4.5 } }
      ],
      "total": 9.2,
      "missing": 0
    }
  ],
  "timestamp": "2026-03-14T10:00:00.000Z"
}
```

---

## GET /api/version

Returns the application version and runtime information.

**Response**
```json
{
  "version": "1.0.0",
  "env": "development",
  "nodeVersion": "v20.11.0",
  "platform": "linux"
}
```

---

## POST /api/admin/clear-cache

Clears the in-memory search result cache. Returns the number of entries that were cleared.

> Note: No authentication is currently enforced. Intended for internal/admin use only.

**Response**
```json
{
  "cleared": 12,
  "timestamp": "2026-03-14T10:00:00.000Z"
}
```

---

## POST /api/admin/reset-analytics

Resets all analytics counters (search counts, cache hit/miss tallies, query frequency data, per-store stats, and response time history).

> Note: No authentication is currently enforced. Intended for internal/admin use only.

**Response**
```json
{
  "reset": true,
  "timestamp": "2026-03-14T10:00:00.000Z"
}
```

---

## GET /api/logs?n=

Returns the most recent server log entries (up to 200 stored).

**Query parameters**

| Parameter | Required | Default | Max |
|-----------|----------|---------|-----|
| `n` | No | `50` | `200` |

**Response**
```json
{
  "logs": [
    { "level": "info", "message": "Server started", "ts": "2026-03-14T09:50:00.000Z" },
    { "level": "error", "message": "Scrape failed: timeout", "ts": "2026-03-14T09:55:00.000Z" }
  ]
}
```
