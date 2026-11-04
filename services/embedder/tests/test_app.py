import json

import pytest

from conftest import AUTH, PHOTO_HOST

PHOTO = f"https://{PHOTO_HOST}/photo.jpg"


def error_code(response) -> str:
    return response.json()["error"]["code"]


class TestSecret:
    def test_health_needs_no_secret(self, client):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok", "model": "fake@0000000", "dimensions": 768}

    @pytest.mark.parametrize(
        "headers",
        [{}, {"authorization": "Bearer wrong"}, {"authorization": AUTH["authorization"] + "x"}],
    )
    def test_everything_else_needs_it(self, client, headers):
        for path, body in [("/embed-text", {"text": "red"}), ("/embed-image", {"url": PHOTO})]:
            response = client.post(path, json=body, headers=headers)
            assert response.status_code == 401
            assert error_code(response) == "unauthorized"
            assert response.json()["error"]["requestId"] == response.headers["x-request-id"]

    def test_is_checked_before_the_body(self, client):
        # A caller without the secret learns nothing about what a valid request looks like.
        response = client.post("/embed-image", json={"nope": 1})
        assert response.status_code == 401


class TestEmbedText:
    def test_gives_one_fingerprint_of_768_numbers(self, client):
        response = client.post("/embed-text", json={"text": "  beige trench "}, headers=AUTH)
        assert response.status_code == 200
        body = response.json()
        assert body["model"] == "fake@0000000"
        assert len(body["embedding"]) == 768
        assert set(body["timing"]) == {"downloadMs", "inferenceMs"}
        assert response.headers["x-request-id"]

    @pytest.mark.parametrize(
        "body", [{"text": ""}, {"text": "   "}, {"text": "x" * 201}, {}, {"text": "a", "b": 1}]
    )
    def test_refuses_empty_long_or_odd_text(self, client, body):
        response = client.post("/embed-text", json=body, headers=AUTH)
        assert response.status_code == 400
        assert error_code(response) == "validation_failed"


class TestEmbedImage:
    def test_whole_photo_without_boxes(self, client, fake):
        response = client.post("/embed-image", json={"url": PHOTO}, headers=AUTH)
        assert response.status_code == 200
        assert len(response.json()["embeddings"]) == 1
        assert fake.sizes == [(100, 50)]

    def test_one_fingerprint_per_box_in_order(self, client, fake):
        boxes = [
            {"left": 0, "top": 0, "right": 0.5, "bottom": 1},
            {"left": 0.25, "top": 0.5, "right": 1, "bottom": 1},
        ]
        response = client.post("/embed-image", json={"url": PHOTO, "boxes": boxes}, headers=AUTH)
        assert response.status_code == 200
        assert len(response.json()["embeddings"]) == 2
        assert fake.sizes == [(50, 50), (75, 25)]

    def test_transparent_parts_become_white(self, client, fake):
        url = f"https://{PHOTO_HOST}/clear.png"
        response = client.post("/embed-image", json={"url": url}, headers=AUTH)
        assert response.status_code == 200
        # The fake fingerprint starts with the average colour: white, normalised.
        head = response.json()["embeddings"][0][:3]
        assert head == pytest.approx([3**-0.5] * 3, abs=1e-5)

    @pytest.mark.parametrize(
        "box",
        [
            {"left": 0.5, "top": 0, "right": 0.5, "bottom": 1},
            {"left": 0, "top": 0.6, "right": 1, "bottom": 0.4},
            {"left": -0.1, "top": 0, "right": 1, "bottom": 1},
            {"left": 0, "top": 0, "right": 1.5, "bottom": 1},
            {"left": 0, "top": 0, "right": 1},
            {"left": 0, "top": 0, "right": 1, "bottom": 1, "depth": 2},
        ],
    )
    def test_refuses_boxes_that_are_not_inside_the_photo(self, client, box):
        response = client.post("/embed-image", json={"url": PHOTO, "boxes": [box]}, headers=AUTH)
        assert response.status_code == 400
        assert error_code(response) == "validation_failed"

    def test_says_which_field_is_wrong_like_the_api(self, client):
        box = {"left": 0, "top": 0, "right": 1, "bottom": 1.5}
        response = client.post("/embed-image", json={"url": PHOTO, "boxes": [box]}, headers=AUTH)
        assert response.status_code == 400
        assert [d["path"] for d in response.json()["error"]["details"]] == ["boxes.0.bottom"]

    @pytest.mark.parametrize("left", ["0.5", True, None])
    def test_refuses_text_or_true_where_a_number_belongs(self, client, left):
        box = {"left": left, "top": 0, "right": 1, "bottom": 1}
        response = client.post("/embed-image", json={"url": PHOTO, "boxes": [box]}, headers=AUTH)
        assert (response.status_code, error_code(response)) == (400, "validation_failed")

    def test_refuses_no_boxes_or_more_than_20(self, client):
        box = {"left": 0, "top": 0, "right": 1, "bottom": 1}
        for boxes in ([], [box] * 21):
            response = client.post(
                "/embed-image", json={"url": PHOTO, "boxes": boxes}, headers=AUTH
            )
            assert response.status_code == 400

    def test_refuses_not_a_number(self, client):
        # Python's JSON reader accepts NaN; a box must not.
        box = {"left": "NAN", "top": 0, "right": 1, "bottom": 1}
        raw = json.dumps({"url": PHOTO, "boxes": [box]}).replace('"NAN"', "NaN")
        response = client.post(
            "/embed-image", content=raw, headers={**AUTH, "content-type": "application/json"}
        )
        assert response.status_code == 400

    def test_refuses_broken_json_and_large_bodies(self, client):
        headers = {**AUTH, "content-type": "application/json"}
        assert client.post("/embed-image", content="{", headers=headers).status_code == 400
        big = json.dumps({"url": PHOTO, "pad": "x" * 70_000})
        response = client.post("/embed-image", content=big, headers=headers)
        assert response.status_code == 413
        assert error_code(response) == "payload_too_large"


class TestPhotoDownload:
    @pytest.mark.parametrize(
        ("url", "status", "code"),
        [
            (f"http://{PHOTO_HOST}/photo.jpg", 403, "forbidden"),
            ("https://evil.example.com/photo.jpg", 403, "forbidden"),
            (f"https://user:pw@{PHOTO_HOST}/photo.jpg", 403, "forbidden"),
            (f"https://{PHOTO_HOST}:99999/photo.jpg", 403, "forbidden"),
            ("file:///etc/passwd", 403, "forbidden"),
            (f"https://{PHOTO_HOST}/photo.jpg\n", 400, "validation_failed"),
            (f"https://{PHOTO_HOST}/pho\tto.jpg", 400, "validation_failed"),
            (f"https://{PHOTO_HOST}/photo.jpg ", 400, "validation_failed"),
            (f"https://{PHOTO_HOST}/redirect.jpg", 502, "service_unavailable"),
            (f"https://{PHOTO_HOST}/missing.jpg", 502, "service_unavailable"),
            (f"https://{PHOTO_HOST}/slow.jpg", 502, "service_unavailable"),
            (f"https://{PHOTO_HOST}/says-big.jpg", 413, "payload_too_large"),
            (f"https://{PHOTO_HOST}/is-big.jpg", 413, "payload_too_large"),
            (f"https://{PHOTO_HOST}/huge.png", 413, "payload_too_large"),
            (f"https://{PHOTO_HOST}/notes.txt", 415, "unsupported_media_type"),
            (f"https://{PHOTO_HOST}/poster.gif", 415, "unsupported_media_type"),
        ],
    )
    def test_refuses_unsafe_or_unusable_photos(self, client, fake, url, status, code):
        response = client.post("/embed-image", json={"url": url}, headers=AUTH)
        assert (response.status_code, error_code(response)) == (status, code)
        assert fake.sizes == []

    @pytest.mark.parametrize(
        "resolved",
        [
            ["10.0.0.5"],
            ["127.0.0.1"],
            ["169.254.169.254"],
            ["fdaa:0:1::3"],
            [],
            ["93.184.216.34", "192.168.1.10"],
        ],
    )
    def test_refuses_hosts_that_resolve_to_private_addresses(self, client, addresses, resolved):
        addresses[:] = resolved
        response = client.post("/embed-image", json={"url": PHOTO}, headers=AUTH)
        assert (response.status_code, error_code(response)) == (403, "forbidden")


class TestErrors:
    def test_unknown_route(self, client):
        response = client.get("/nope", headers=AUTH)
        assert (response.status_code, error_code(response)) == (404, "not_found")

    def test_a_crash_is_a_500_in_the_same_format(self, client, fake):
        fake.fail = True
        response = client.post("/embed-image", json={"url": PHOTO}, headers=AUTH)
        assert (response.status_code, error_code(response)) == (500, "internal_error")
        assert "model broke" not in response.text
