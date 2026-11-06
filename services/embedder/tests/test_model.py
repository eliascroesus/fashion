"""The real model (needs `python -m embedder.download_model` first; skipped without it)."""

import math

import pytest
from PIL import Image

from embedder.images import crop
from embedder.model import DIMENSIONS, FashionSigLIP
from embedder.settings import model_dir_from_env

MODEL_DIR = model_dir_from_env()
pytestmark = [
    pytest.mark.model,
    pytest.mark.skipif(
        not (MODEL_DIR / "open_clip_model.safetensors").exists(),
        reason="model files not downloaded (python -m embedder.download_model)",
    ),
]

RED = (200, 25, 30)
BLUE = (25, 40, 200)


@pytest.fixture(scope="module")
def model() -> FashionSigLIP:
    return FashionSigLIP(MODEL_DIR)


def similarity(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def norm(v: list[float]) -> float:
    return math.sqrt(sum(x * x for x in v))


def test_photo_fingerprints_are_768_numbers_of_length_1(model):
    [fingerprint] = model.embed_images([Image.new("RGB", (300, 400), RED)])
    assert len(fingerprint) == DIMENSIONS
    assert norm(fingerprint) == pytest.approx(1, abs=1e-4)


def test_the_same_photo_gives_the_same_fingerprint(model):
    photo = Image.new("RGB", (300, 400), BLUE)
    first, second = model.embed_images([photo, photo.copy()])
    assert first == pytest.approx(second, abs=1e-5)


def test_words_and_pictures_meet(model):
    red, blue = model.embed_images([Image.new("RGB", (224, 224), c) for c in (RED, BLUE)])
    red_dress, blue_dress = model.embed_text("a red dress"), model.embed_text("a blue dress")
    assert similarity(red, red_dress) > similarity(red, blue_dress)
    assert similarity(blue, blue_dress) > similarity(blue, red_dress)


def test_a_crop_sees_only_its_box(model):
    half_and_half = Image.new("RGB", (400, 300), BLUE)
    half_and_half.paste(Image.new("RGB", (200, 300), RED), (0, 0))
    left = crop(half_and_half, 0, 0, 0.5, 1)
    red, blue, left_half = model.embed_images(
        [Image.new("RGB", (200, 300), RED), Image.new("RGB", (200, 300), BLUE), left]
    )
    assert similarity(left_half, red) > similarity(left_half, blue)
    assert similarity(left_half, red) > 0.99


def test_text_fingerprints_are_768_numbers_of_length_1(model):
    fingerprint = model.embed_text("beige trench")
    assert len(fingerprint) == DIMENSIONS
    assert norm(fingerprint) == pytest.approx(1, abs=1e-4)
