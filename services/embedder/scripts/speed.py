"""Times the live fingerprint service with real photos from the staging feed.

    pnpm embedder:speed [--count 30] [--boxes 0]

Reads EMBEDDER_URL and EMBEDDER_SECRET (root .env). The first call shows how long
waking the machine takes; then each photo is timed over HTTP from here and by the
server itself (download + model).
"""

import argparse
import os
import statistics
import time

import httpx

API = "https://outfitly-api-staging.fly.dev"


def photo_links(client: httpx.Client, count: int) -> list[str]:
    links: list[str] = []
    cursor = None
    while len(links) < count:
        params = {"cursor": cursor} if cursor else {}
        page = client.get(f"{API}/v1/feed/for-you", params=params, timeout=60).json()
        links += [item["photo"]["urls"]["1080"] for item in page["items"]]
        cursor = page.get("nextCursor")
        if not cursor:
            break
    return links[:count]


def summary(name: str, values: list[float]) -> str:
    ordered = sorted(values)
    p95 = ordered[min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))]
    return (
        f"{name:<22} p50 {statistics.median(ordered):6.0f} ms   p95 {p95:6.0f} ms"
        f"   max {ordered[-1]:6.0f} ms"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=30)
    parser.add_argument("--boxes", type=int, default=0, help="crop boxes per photo (0 = whole)")
    args = parser.parse_args()

    base = os.environ["EMBEDDER_URL"].rstrip("/")
    headers = {"authorization": f"Bearer {os.environ['EMBEDDER_SECRET']}"}
    # Side-by-side strips, like garments across a photo.
    step = 1 / max(args.boxes, 1)
    boxes = [
        {"left": i * step, "top": 0.1, "right": min(1.0, (i + 1) * step), "bottom": 0.9}
        for i in range(args.boxes)
    ]

    with httpx.Client(timeout=120) as client:
        links = photo_links(client, args.count)
        print(f"{len(links)} photos from the staging feed, {args.boxes or 'no'} boxes each\n")

        started = time.perf_counter()
        first = client.post(f"{base}/embed-text", json={"text": "beige trench"}, headers=headers)
        first.raise_for_status()
        print(f"first call (wakes the machine): {(time.perf_counter() - started) * 1000:.0f} ms")

        network = []
        for _ in range(5):
            started = time.perf_counter()
            client.get(f"{base}/health").raise_for_status()
            network.append((time.perf_counter() - started) * 1000)

        wall, server, download, inference = [], [], [], []
        for link in links:
            body = {"url": link, **({"boxes": boxes} if boxes else {})}
            started = time.perf_counter()
            response = client.post(f"{base}/embed-image", json=body, headers=headers)
            wall.append((time.perf_counter() - started) * 1000)
            response.raise_for_status()
            timing = response.json()["timing"]
            download.append(timing["downloadMs"])
            inference.append(timing["inferenceMs"])
            server.append(timing["downloadMs"] + timing["inferenceMs"])

    print(summary("health (network)", network))
    print(summary("photo over HTTP", wall))
    print(summary("photo, server's time", server))
    print(summary("  download + decode", download))
    print(summary("  model", inference))
    if len(server) >= 40:
        print(
            f"\nserver's time, first 20 p50 {statistics.median(server[:20]):.0f} ms, "
            f"last 20 p50 {statistics.median(server[-20:]):.0f} ms (throttling shows here)"
        )


if __name__ == "__main__":
    main()
