"""
Proxy pool: fetches free proxies from multiple sources, validates them concurrently.
"""

import asyncio
import aiohttp
import json
import time
import logging
from dataclasses import dataclass, field
from typing import Optional

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

TEST_URL = "https://httpbin.org/ip"
TIMEOUT = 4
VALIDATE_CONCURRENCY = 200
MAX_PROXIES_TO_VALIDATE = 500   # cap to keep startup fast
REFRESH_INTERVAL = 300  # seconds between pool refreshes


@dataclass
class Proxy:
    host: str
    port: int
    protocol: str = "http"
    latency: float = 0.0
    failures: int = 0
    last_used: float = field(default_factory=time.time)

    @property
    def url(self) -> str:
        return f"{self.protocol}://{self.host}:{self.port}"

    def mark_failure(self):
        self.failures += 1

    def mark_success(self, latency: float):
        self.latency = latency
        self.failures = 0
        self.last_used = time.time()


SOURCES = [
    # GeoNode — large free pool
    {
        "url": "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc&protocols=http%2Chttps",
        "parse": lambda data: [
            Proxy(host=p["ip"], port=int(p["port"]), protocol=p["protocols"][0])
            for p in data.get("data", [])
            if p.get("ip") and p.get("port")
        ],
    },
    # Proxyscrape — plain text list
    {
        "url": "https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&timeout=5000&country=all&ssl=all&anonymity=elite",
        "parse": lambda data: [
            Proxy(host=line.split(":")[0], port=int(line.split(":")[1]), protocol="http")
            for line in (data if isinstance(data, str) else "").strip().splitlines()
            if ":" in line and line.split(":")[1].isdigit()
        ],
    },
    # OpenProxyList — JSON
    {
        "url": "https://openproxylist.xyz/http.txt",
        "parse": lambda data: [
            Proxy(host=line.split(":")[0], port=int(line.split(":")[1]), protocol="http")
            for line in (data if isinstance(data, str) else "").strip().splitlines()
            if ":" in line
        ],
    },
]


LOCAL_PROXY_FILE = "proxies.txt"


def load_local_proxies() -> list[Proxy]:
    """
    Load proxies from a local file (proxies.txt).
    One proxy per line in format:  host:port  or  http://host:port
    """
    import os
    proxies = []
    path = os.path.join(os.path.dirname(__file__), LOCAL_PROXY_FILE)
    if not os.path.exists(path):
        return proxies
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # strip protocol prefix
            for prefix in ("http://", "https://", "socks5://", "socks4://"):
                if line.startswith(prefix):
                    protocol = prefix.rstrip("://")
                    line = line[len(prefix):]
                    break
            else:
                protocol = "http"
            if ":" in line:
                host, port_str = line.rsplit(":", 1)
                try:
                    proxies.append(Proxy(host=host, port=int(port_str), protocol=protocol))
                except ValueError:
                    pass
    log.info(f"Loaded {len(proxies)} proxies from {LOCAL_PROXY_FILE}")
    return proxies


async def fetch_source(session: aiohttp.ClientSession, source: dict) -> list[Proxy]:
    try:
        async with session.get(source["url"], timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status == 200:
                data = await r.json(content_type=None)
                proxies = source["parse"](data)
                log.info(f"Fetched {len(proxies)} proxies from {source['url'][:60]}...")
                return proxies
    except Exception as e:
        log.warning(f"Failed to fetch from {source['url'][:60]}: {e}")
    return []


async def validate_proxy(proxy: Proxy) -> Optional[Proxy]:
    """
    Validate proxy with a real CONNECT+TLS test (httpbin.org:443).
    This ensures the proxy can actually tunnel HTTPS, not just HTTP.
    """
    start = time.time()
    try:
        # Step 1: open TCP connection to proxy
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(proxy.host, proxy.port), timeout=TIMEOUT
        )
        # Step 2: send CONNECT
        writer.write(b"CONNECT httpbin.org:443 HTTP/1.1\r\nHost: httpbin.org:443\r\n\r\n")
        await writer.drain()

        # Step 3: read response
        resp = await asyncio.wait_for(reader.readline(), timeout=TIMEOUT)
        if b"200" not in resp:
            writer.close()
            return None

        # Drain headers
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=TIMEOUT)
            if line in (b"\r\n", b"\n", b""):
                break

        # Step 4: TLS handshake through tunnel
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        transport = writer.transport
        loop = asyncio.get_event_loop()
        tls_transport, _ = await asyncio.wait_for(
            loop.start_tls(transport, asyncio.Protocol(), ctx, server_side=False, server_hostname="httpbin.org"),
            timeout=TIMEOUT
        )

        # Step 5: send HTTP request through TLS
        tls_transport.write(
            b"GET /ip HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n"
        )

        # Step 6: read response (just check first line)
        resp_data = b""
        for _ in range(10):
            chunk = await asyncio.wait_for(reader.read(512), timeout=TIMEOUT)
            if not chunk:
                break
            resp_data += chunk
            if b"200" in resp_data or b"\r\n\r\n" in resp_data:
                break

        tls_transport.close()
        if b"200" in resp_data or b'"origin"' in resp_data:
            proxy.mark_success(latency=round(time.time() - start, 2))
            return proxy

    except Exception:
        pass
    return None


async def validate_all(proxies: list[Proxy]) -> list[Proxy]:
    sem = asyncio.Semaphore(VALIDATE_CONCURRENCY)

    async def guarded(proxy):
        async with sem:
            return await validate_proxy(proxy)

    results = await asyncio.gather(*[guarded(p) for p in proxies])

    valid = [p for p in results if p is not None]
    valid.sort(key=lambda p: p.latency)
    log.info(f"Validation complete: {len(valid)}/{len(proxies)} proxies support HTTPS CONNECT")
    return valid


async def fetch_source_text(session: aiohttp.ClientSession, source: dict) -> list[Proxy]:
    """Fetch source that returns plain text instead of JSON."""
    try:
        async with session.get(source["url"], timeout=aiohttp.ClientTimeout(total=15)) as r:
            if r.status == 200:
                text = await r.text()
                proxies = source["parse"](text)
                log.info(f"Fetched {len(proxies)} proxies from {source['url'][:60]}...")
                return proxies
    except Exception as e:
        log.warning(f"Failed to fetch from {source['url'][:60]}: {e}")
    return []


async def fetch_and_validate() -> list[Proxy]:
    all_proxies: list[Proxy] = []
    seen = set()

    # Always include local file proxies first
    for p in load_local_proxies():
        key = f"{p.host}:{p.port}"
        if key not in seen:
            seen.add(key)
            all_proxies.append(p)

    connector = aiohttp.TCPConnector(ssl=False)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = []
        for src in SOURCES:
            # Detect if source returns JSON or plain text based on URL
            if "proxyscrape" in src["url"] or "openproxylist" in src["url"]:
                tasks.append(fetch_source_text(session, src))
            else:
                tasks.append(fetch_source(session, src))
        results = await asyncio.gather(*tasks, return_exceptions=True)

    for batch in results:
        if isinstance(batch, Exception):
            continue
        for p in batch:
            key = f"{p.host}:{p.port}"
            if key not in seen:
                seen.add(key)
                all_proxies.append(p)

    if not all_proxies:
        log.warning("No proxies found from any source. Add proxies to proxies.txt to use a custom list.")
        return []

    # Cap to avoid multi-minute validation
    if len(all_proxies) > MAX_PROXIES_TO_VALIDATE:
        import random
        all_proxies = random.sample(all_proxies, MAX_PROXIES_TO_VALIDATE)

    log.info(f"Total unique proxies to validate: {len(all_proxies)}")
    return await validate_all(all_proxies)


if __name__ == "__main__":
    proxies = asyncio.run(fetch_and_validate())
    print(f"\n=== Working proxies ({len(proxies)}) ===")
    for p in proxies[:20]:
        print(f"  {p.url:40s}  latency={p.latency}s")
