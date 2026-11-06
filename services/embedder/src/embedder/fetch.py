"""Safe photo download (CLAUDE.md: any server fetch of an external link gets SSRF
protection, timeouts and size limits).

Photos may only come over https from the allowed hosts (our photo CDN), and every
address the host name resolves to must be public: no private networks, Fly's
internal network, localhost or cloud metadata. httpx resolves the name again when
it connects, so a host that changes its answer in between could slip past the
address check; the host allow-list is what rules that out.
"""

import ipaddress
import socket
import time
from collections.abc import Callable, Iterable
from urllib.parse import urlsplit

import httpx

MAX_BYTES = 15 * 1024 * 1024
CONNECT_SECONDS = 3.0
TOTAL_SECONDS = 10.0
# NAT64 addresses carry an IPv4 address in their last 32 bits.
NAT64 = ipaddress.ip_network("64:ff9b::/96")
# The only IPv6 range in use on the public internet; everything outside it (old
# IPv4-compatible forms, site-local, …) is refused.
GLOBAL_UNICAST = ipaddress.ip_network("2000::/3")

Resolver = Callable[[str, int], Iterable[str]]


class FetchError(Exception):
    """A photo we won't or can't use; `code` is one of the API's error codes. A 502 with
    `service_unavailable` means the photo couldn't be downloaded: worth trying again later."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def system_resolver(host: str, port: int) -> list[str]:
    return [str(info[4][0]) for info in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]


def is_public(address: str) -> bool:
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        elif ip in NAT64:
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
        elif ip.sixtofour or ip.teredo:
            return False  # tunnels to an IPv4 address we can't vouch for
        elif ip not in GLOBAL_UNICAST:
            return False
    return ip.is_global and not ip.is_multicast


def check_url(url: str, allowed_hosts: frozenset[str]) -> tuple[str, int]:
    # urlsplit quietly drops tabs and newlines that the downloader would refuse.
    if any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in url):
        raise FetchError(400, "validation_failed", "Photo links can't contain spaces.")
    parts = urlsplit(url)
    if parts.scheme != "https":
        raise FetchError(403, "forbidden", "Photo links must start with https://.")
    if parts.username or parts.password:
        raise FetchError(403, "forbidden", "Photo links can't carry a login.")
    host = (parts.hostname or "").lower()
    if host not in allowed_hosts:
        raise FetchError(403, "forbidden", "Photos can only come from our photo host.")
    try:
        port = parts.port or 443
    except ValueError as error:
        raise FetchError(403, "forbidden", "That photo link has a bad port.") from error
    return host, port


def new_client() -> httpx.Client:
    # trust_env=False: no proxy from the environment can route around the checks.
    return httpx.Client(
        timeout=httpx.Timeout(TOTAL_SECONDS, connect=CONNECT_SECONDS),
        follow_redirects=False,
        trust_env=False,
        headers={"user-agent": "OutfitlyEmbedder/1"},
    )


def fetch_bytes(
    url: str,
    *,
    client: httpx.Client,
    allowed_hosts: frozenset[str],
    resolve: Resolver = system_resolver,
) -> bytes:
    host, port = check_url(url, allowed_hosts)
    try:
        addresses = list(resolve(host, port))
    except OSError as error:
        raise FetchError(502, "service_unavailable", "Couldn't find the photo's server.") from error
    if not addresses or not all(is_public(a) for a in addresses):
        raise FetchError(403, "forbidden", "That photo host isn't on the public internet.")

    deadline = time.monotonic() + TOTAL_SECONDS
    data = bytearray()
    try:
        with client.stream("GET", url) as response:
            if response.status_code != 200:
                raise FetchError(
                    502,
                    "service_unavailable",
                    f"The photo's server answered {response.status_code}.",
                )
            declared = response.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > MAX_BYTES:
                raise FetchError(413, "payload_too_large", "The photo is over 15 MB.")
            for chunk in response.iter_bytes():
                data += chunk
                if len(data) > MAX_BYTES:
                    raise FetchError(413, "payload_too_large", "The photo is over 15 MB.")
                if time.monotonic() > deadline:
                    raise httpx.ReadTimeout("total time limit", request=response.request)
    except httpx.InvalidURL as error:
        raise FetchError(400, "validation_failed", "That photo link isn't valid.") from error
    except httpx.TimeoutException as error:
        raise FetchError(502, "service_unavailable", "The photo took too long.") from error
    except httpx.HTTPError as error:
        raise FetchError(502, "service_unavailable", "Couldn't download the photo.") from error
    return bytes(data)
