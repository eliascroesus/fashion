"""Turning downloaded bytes into a picture the model can read, and cutting out boxes."""

import math
import threading
import warnings
from io import BytesIO

from PIL import Image, ImageOps

from embedder.fetch import FetchError

FORMATS = ("JPEG", "PNG", "WEBP")
# Our photos are at most 1080 px wide (about 1.5 megapixels); this leaves plenty of room.
MAX_PIXELS = 25_000_000
# A 25-megapixel picture takes ~150 MB while decoding; at most two at once on a 2 GB machine
# that already holds the model (1.35 GB).
_decoding = threading.BoundedSemaphore(2)


def decode(data: bytes) -> Image.Image:
    """An RGB picture, upright, with transparency on white. Refuses anything but JPEG,
    PNG or WebP, and pictures over 25 megapixels (checked before decoding)."""
    with _decoding:
        return _decode(data)


def _decode(data: bytes) -> Image.Image:
    too_large = FetchError(413, "payload_too_large", "The photo is over 25 megapixels.")
    not_a_photo = FetchError(415, "unsupported_media_type", "That isn't a JPEG, PNG or WebP photo.")
    try:
        # Opening reads only the header; our own limit below is stricter than Pillow's warning.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            image = Image.open(BytesIO(data), formats=FORMATS)
    except Image.DecompressionBombError as error:
        raise too_large from error
    except (OSError, SyntaxError, ValueError) as error:  # unknown or broken file
        raise not_a_photo from error
    width, height = image.size
    if width * height > MAX_PIXELS:
        raise too_large
    try:
        image.load()
    except (OSError, SyntaxError, ValueError) as error:
        raise not_a_photo from error
    ImageOps.exif_transpose(image, in_place=True)
    return _rgb(image)


def _rgb(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA") or "transparency" in image.info:
        rgba = image.convert("RGBA")
        white = Image.new("RGB", rgba.size, (255, 255, 255))
        white.paste(rgba, mask=rgba.getchannel("A"))
        return white
    return image.convert("RGB")


def crop(image: Image.Image, left: float, top: float, right: float, bottom: float) -> Image.Image:
    """The part of the picture inside a box given in fractions (0–1), at least 1×1 pixel."""
    width, height = image.size
    x0 = min(math.floor(left * width), width - 1)
    y0 = min(math.floor(top * height), height - 1)
    x1 = min(max(math.ceil(right * width), x0 + 1), width)
    y1 = min(max(math.ceil(bottom * height), y0 + 1), height)
    return image.crop((x0, y0, x1, y1))
