"""
Rotating proxy server — listens on localhost:8080, forwards through a live proxy pool.
- Round-robins across working proxies
- Retries on failure, marks bad proxies
- Auto-refreshes pool in background every REFRESH_INTERVAL seconds
"""

import asyncio
import logging
import time
import itertools
import signal
import sys
from typing import Optional

import aiohttp
from aiohttp import web

from pool import Proxy, fetch_and_validate, REFRESH_INTERVAL

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8080
MAX_FAILURES = 3      # remove proxy after this many failures
RETRY_COUNT = 3       # retries per request before giving up


class ProxyPool:
    def __init__(self):
        self._proxies: list[Proxy] = []
        self._cycle = itertools.cycle([])
        self._lock = asyncio.Lock()
        self._last_refresh = 0.0

    async def refresh(self):
        log.info("Refreshing proxy pool...")
        new_proxies = await fetch_and_validate()
        async with self._lock:
            self._proxies = new_proxies
            self._cycle = itertools.cycle(self._proxies) if self._proxies else itertools.cycle([])
            self._last_refresh = time.time()
        log.info(f"Pool updated: {len(self._proxies)} working proxies")

    async def get(self) -> Optional[Proxy]:
        async with self._lock:
            if not self._proxies:
                return None
            for _ in range(len(self._proxies)):
                proxy = next(self._cycle)
                if proxy.failures < MAX_FAILURES:
                    return proxy
            return None

    async def mark_failure(self, proxy: Proxy):
        async with self._lock:
            proxy.mark_failure()
            if proxy.failures >= MAX_FAILURES:
                if proxy in self._proxies:
                    self._proxies.remove(proxy)
                    self._cycle = itertools.cycle(self._proxies) if self._proxies else itertools.cycle([])
                    log.warning(f"Removed dead proxy {proxy.url} ({len(self._proxies)} remaining)")

    def size(self) -> int:
        return len(self._proxies)


pool = ProxyPool()


async def background_refresh(app):
    """Periodically refreshes the proxy pool."""
    while True:
        try:
            await asyncio.sleep(REFRESH_INTERVAL)
            await pool.refresh()
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.error(f"Background refresh error: {e}")


async def forward_request(request: web.Request) -> web.Response:
    """Forward the incoming HTTP request through a rotating proxy."""
    url = str(request.url)
    body = await request.read()
    headers = {k: v for k, v in request.headers.items()
               if k.lower() not in ("host", "proxy-connection", "proxy-authorization")}

    last_error = None
    for attempt in range(1, RETRY_COUNT + 1):
        proxy = await pool.get()
        if proxy is None:
            log.warning("No proxies available — waiting for pool refresh")
            await asyncio.sleep(5)
            continue

        log.debug(f"[{attempt}] {request.method} {url} via {proxy.url}")
        try:
            connector = aiohttp.TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.request(
                    method=request.method,
                    url=url,
                    headers=headers,
                    data=body if body else None,
                    proxy=proxy.url,
                    timeout=aiohttp.ClientTimeout(total=15),
                    allow_redirects=True,
                    ssl=False,
                ) as resp:
                    content = await resp.read()
                    proxy.mark_success(latency=0.0)
                    return web.Response(
                        status=resp.status,
                        headers={k: v for k, v in resp.headers.items()
                                 if k.lower() not in ("transfer-encoding", "content-encoding")},
                        body=content,
                    )
        except Exception as e:
            last_error = e
            log.debug(f"Proxy {proxy.url} failed: {e}")
            await pool.mark_failure(proxy)

    log.error(f"All {RETRY_COUNT} attempts failed for {url}: {last_error}")
    return web.Response(status=502, text=f"Proxy failed after {RETRY_COUNT} attempts: {last_error}")


async def handle_connect(request: web.Request) -> web.StreamResponse:
    """Handle HTTPS CONNECT tunneling."""
    host, _, port_str = request.path.partition(":")
    port = int(port_str) if port_str else 443

    proxy = await pool.get()
    if proxy is None:
        return web.Response(status=503, text="No proxies available")

    try:
        # Open tunnel to upstream proxy
        reader, writer = await asyncio.open_connection(proxy.host, proxy.port)
        connect_req = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n"
        writer.write(connect_req.encode())
        await writer.drain()

        response_line = await reader.readline()
        if b"200" not in response_line:
            writer.close()
            await pool.mark_failure(proxy)
            return web.Response(status=502, text="Upstream CONNECT failed")

        # Drain rest of response headers
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break

        # Send 200 to client
        resp = web.StreamResponse(status=200, reason="Connection Established")
        await resp.prepare(request)

        # Pipe data both ways
        async def pipe(src, dst):
            try:
                while True:
                    data = await src.read(8192)
                    if not data:
                        break
                    dst.write(data)
                    await dst.drain()
            except Exception:
                pass

        client_reader = request.transport
        await asyncio.gather(
            pipe(reader, writer),
            return_exceptions=True
        )
        writer.close()
        return resp

    except Exception as e:
        await pool.mark_failure(proxy)
        return web.Response(status=502, text=f"CONNECT tunnel error: {e}")


async def handle(request: web.Request) -> web.Response:
    if request.method == "CONNECT":
        return await handle_connect(request)
    return await forward_request(request)


async def status_handler(request: web.Request) -> web.Response:
    return web.json_response({
        "status": "running",
        "pool_size": pool.size(),
        "last_refresh": pool._last_refresh,
    })


async def on_startup(app):
    log.info("Initial proxy pool fetch...")
    await pool.refresh()
    app["refresh_task"] = asyncio.create_task(background_refresh(app))


async def on_shutdown(app):
    app["refresh_task"].cancel()
    await app["refresh_task"]


def main():
    app = web.Application()
    app.router.add_route("*", "/{path_info:.*}", handle)
    app.router.add_get("/__status__", status_handler)
    app.on_startup.append(on_startup)
    app.on_shutdown.append(on_shutdown)

    log.info(f"Starting rotating proxy server on {LISTEN_HOST}:{LISTEN_PORT}")
    log.info(f"Status endpoint: http://{LISTEN_HOST}:{LISTEN_PORT}/__status__")
    web.run_app(app, host=LISTEN_HOST, port=LISTEN_PORT, access_log=None)


if __name__ == "__main__":
    main()
