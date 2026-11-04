"""A crash reaches Sentry without the secret or the photo link."""

import dataclasses

import httpx
import sentry_sdk
from fastapi.testclient import TestClient
from sentry_sdk.transport import Transport

from conftest import AUTH, PHOTO_HOST, SECRET, photo_server
from embedder.app import create_app, init_sentry


class Captured(Transport):
    envelopes: list[bytes] = []  # noqa: RUF012 (shared on purpose: Sentry makes its own instance)

    def capture_envelope(self, envelope) -> None:
        Captured.envelopes.append(envelope.serialize())


def test_a_crash_report_holds_neither_the_secret_nor_the_link(settings, fake, addresses):
    fake.fail = True
    settings = dataclasses.replace(settings, sentry_dsn="https://key@o0.ingest.sentry.io/0")
    Captured.envelopes = []
    init_sentry(settings, transport=Captured)
    try:
        app = create_app(
            settings,
            load_embedder=lambda: fake,
            http_client=httpx.Client(transport=httpx.MockTransport(photo_server)),
            resolve=lambda _host, _port: addresses,
        )
        with TestClient(app, raise_server_exceptions=False) as client:
            url = f"https://{PHOTO_HOST}/photo.jpg"
            response = client.post("/embed-image", json={"url": url}, headers=AUTH)
        assert response.status_code == 500
        sentry_sdk.flush()
    finally:
        sentry_sdk.init()  # Sentry off again for the other tests

    sent = b"".join(Captured.envelopes)
    assert b"model broke" in sent  # the crash itself was reported…
    assert SECRET.encode() not in sent  # …without the secret
    assert PHOTO_HOST.encode() not in sent  # …or the photo link
