"""
Rotating proxy server — listens on localhost:8080, forwards through a live proxy pool.
Uses raw asyncio TCP so CONNECT tunneling works correctly for HTTPS.
"""

import asyncio
import json
import logging
import time
import itertools
from typing import Optional

import aiohttp

from pool import Proxy, fetch_and_validate, REFRESH_INTERVAL

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8080
MAX_FAILURES = 3
RETRY_COUNT = 3
PIPE_TIMEOUT = 60


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
            if proxy.failures >= MAX_FAILURES and proxy in self._proxies:
                self._proxies.remove(proxy)
                self._cycle = itertools.cycle(self._proxies) if self._proxies else itertools.cycle([])
                log.warning(f"Removed dead proxy {proxy.url} ({len(self._proxies)} remaining)")

    def size(self) -> int:
        return len(self._proxies)


pool = ProxyPool()


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(8192), timeout=PIPE_TIMEOUT)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def handle_connect(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter, target: str):
    """HTTPS tunnel: CONNECT host:port — pipe through upstream proxy."""
    host, _, port_str = target.partition(":")
    port = int(port_str) if port_str else 443

    for attempt in range(RETRY_COUNT):
        proxy = await pool.get()
        if proxy is None:
            client_writer.write(b"HTTP/1.1 503 No proxies available\r\n\r\n")
            await client_writer.drain()
            return

        try:
            up_reader, up_writer = await asyncio.wait_for(
                asyncio.open_connection(proxy.host, proxy.port), timeout=10
            )
            # Send CONNECT to upstream proxy
            up_writer.write(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
            await up_writer.drain()

            # Read upstream response
            resp_line = await asyncio.wait_for(up_reader.readline(), timeout=10)
            if b"200" not in resp_line:
                up_writer.close()
                await pool.mark_failure(proxy)
                continue

            # Drain response headers
            while True:
                line = await asyncio.wait_for(up_reader.readline(), timeout=10)
                if line in (b"\r\n", b"\n", b""):
                    break

            # Tell client tunnel is open
            client_writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await client_writer.drain()

            # Bidirectional pipe
            await asyncio.gather(
                pipe(client_reader, up_writer),
                pipe(up_reader, client_writer),
            )
            return

        except Exception as e:
            log.debug(f"CONNECT via {proxy.url} failed: {e}")
            await pool.mark_failure(proxy)

    client_writer.write(b"HTTP/1.1 502 All proxies failed\r\n\r\n")
    await client_writer.drain()


async def handle_http(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter,
                      method: str, url: str, headers: dict, body: bytes):
    """Plain HTTP request — forward through upstream proxy."""
    for attempt in range(RETRY_COUNT):
        proxy = await pool.get()
        if proxy is None:
            await asyncio.sleep(2)
            continue
        try:
            connector = aiohttp.TCPConnector(ssl=False)
            async with aiohttp.ClientSession(connector=connector) as session:
                async with session.request(
                    method=method, url=url, headers=headers,
                    data=body or None, proxy=proxy.url,
                    timeout=aiohttp.ClientTimeout(total=15),
                    allow_redirects=True, ssl=False,
                ) as resp:
                    content = await resp.read()
                    proxy.mark_success(0.0)

                    resp_headers = ""
                    for k, v in resp.headers.items():
                        if k.lower() not in ("transfer-encoding", "content-encoding"):
                            resp_headers += f"{k}: {v}\r\n"

                    response = (
                        f"HTTP/1.1 {resp.status} {resp.reason}\r\n"
                        f"{resp_headers}"
                        f"Content-Length: {len(content)}\r\n"
                        f"Connection: close\r\n\r\n"
                    ).encode() + content

                    client_writer.write(response)
                    await client_writer.drain()
                    return

        except Exception as e:
            log.debug(f"HTTP via {proxy.url} failed: {e}")
            await pool.mark_failure(proxy)

    client_writer.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\nAll proxies failed")
    await client_writer.drain()


async def handle_client(client_reader: asyncio.StreamReader, client_writer: asyncio.StreamWriter):
    peer = client_writer.get_extra_info("peername")
    try:
        # Read request line
        request_line = await asyncio.wait_for(client_reader.readline(), timeout=15)
        if not request_line:
            return

        parts = request_line.decode(errors="replace").strip().split()
        if len(parts) < 3:
            return
        method, target, _ = parts[0], parts[1], parts[2]

        # Read headers
        headers = {}
        while True:
            line = await asyncio.wait_for(client_reader.readline(), timeout=10)
            if line in (b"\r\n", b"\n", b""):
                break
            if b":" in line:
                k, _, v = line.decode(errors="replace").partition(":")
                headers[k.strip()] = v.strip()

        # Status endpoint
        if method == "GET" and target == "/__status__":
            body = json.dumps({
                "status": "running",
                "pool_size": pool.size(),
                "last_refresh": pool._last_refresh,
            }).encode()
            client_writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode() + body
            )
            await client_writer.drain()
            return

        if method == "CONNECT":
            await handle_connect(client_reader, client_writer, target)
        else:
            content_length = int(headers.get("Content-Length", 0))
            body = await client_reader.read(content_length) if content_length > 0 else b""
            clean_headers = {k: v for k, v in headers.items()
                             if k.lower() not in ("proxy-connection", "proxy-authorization")}
            await handle_http(client_reader, client_writer, method, target, clean_headers, body)

    except Exception as e:
        log.debug(f"Client handler error ({peer}): {e}")
    finally:
        try:
            client_writer.close()
        except Exception:
            pass


async def background_refresh():
    while True:
        try:
            await asyncio.sleep(REFRESH_INTERVAL)
            await pool.refresh()
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.error(f"Background refresh error: {e}")


async def main():
    await pool.refresh()

    server = await asyncio.start_server(handle_client, LISTEN_HOST, LISTEN_PORT)
    refresh_task = asyncio.create_task(background_refresh())

    log.info(f"Proxy server running on {LISTEN_HOST}:{LISTEN_PORT}")
    log.info(f"Test: curl -x http://{LISTEN_HOST}:{LISTEN_PORT} https://httpbin.org/ip")

    async with server:
        try:
            await server.serve_forever()
        except asyncio.CancelledError:
            pass
        finally:
            refresh_task.cancel()


if __name__ == "__main__":
    asyncio.run(main())
