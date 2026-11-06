"""Fast tests use a fake model and a fake photo server; nothing touches the network."""

import math
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from embedder.app import create_app
from embedder.model import DIMENSIONS
from embedder.settings import Settings

SECRET = "s" * 40
PHOTO_HOST = "img.example.com"
PUBLIC_ADDRESS = "93.184.216.34"
AUTH = {"authorization": f"Bearer {SECRET}"}


def picture_bytes(size=(100, 50), color=(200, 30, 30), fmt="JPEG", mode="RGB") -> bytes:
    out = BytesIO()
    Image.new(mode, size, color).save(out, fmt)
    return out.getvalue()


class FakeEmbedder:
    """A fingerprint from the picture's average colour, and a record of the picture sizes."""

    name = "fake@0000000"

    def __init__(self) -> None:
        self.sizes: list[tuple[int, int]] = []
        self.fail = False

    def embed_images(self, images: list[Image.Image]) -> list[list[float]]:
        if self.fail:
            raise RuntimeError("model broke")
        self.sizes += [image.size for image in images]
        return [self._unit(list(image.resize((1, 1)).getpixel((0, 0)))) for image in images]

    def embed_text(self, text: str) -> list[float]:
        return self._unit([len(text), 1, 1])

    @staticmethod
    def _unit(head: list[float]) -> list[float]:
        vector = [float(x) for x in head] + [0.0] * (DIMENSIONS - len(head))
        norm = math.sqrt(sum(x * x for x in vector)) or 1.0
        return [x / norm for x in vector]


def photo_server(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/photo.jpg":
        return httpx.Response(200, content=picture_bytes())
    if path == "/clear.png":
        return httpx.Response(200, content=picture_bytes((4, 4), (0, 0, 0, 0), "PNG", "RGBA"))
    if path == "/redirect.jpg":
        return httpx.Response(302, headers={"location": "http://169.254.169.254/"})
    if path == "/says-big.jpg":
        return httpx.Response(200, headers={"content-length": str(16 * 1024 * 1024)})
    if path == "/is-big.jpg":
        # Sent in pieces without a declared size: 16 MB.
        return httpx.Response(200, content=iter([b"\xff" * 1024 * 1024] * 16))
    if path == "/slow.jpg":
        raise httpx.ReadTimeout("slow", request=request)
    if path == "/notes.txt":
        return httpx.Response(200, content=b"just some text")
    if path == "/poster.gif":
        return httpx.Response(200, content=picture_bytes((10, 10), fmt="GIF", mode="P"))
    if path == "/huge.png":
        # 8000 × 7000 = 56 megapixels, but tiny as a 1-bit PNG.
        return httpx.Response(200, content=picture_bytes((8000, 7000), 0, "PNG", "1"))
    return httpx.Response(404)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        secret=SECRET,
        image_hosts=frozenset({PHOTO_HOST}),
        model_dir=tmp_path,
        sentry_dsn=None,
        sentry_environment=None,
    )


@pytest.fixture
def fake() -> FakeEmbedder:
    return FakeEmbedder()


@pytest.fixture
def addresses() -> list[str]:
    """What the photo host's name resolves to; tests change it."""
    return [PUBLIC_ADDRESS]


@pytest.fixture
def client(settings: Settings, fake: FakeEmbedder, addresses: list[str]):
    app = create_app(
        settings,
        load_embedder=lambda: fake,
        http_client=httpx.Client(transport=httpx.MockTransport(photo_server)),
        resolve=lambda _host, _port: addresses,
    )
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client
