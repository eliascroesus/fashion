"""The safety checks and picture helpers on their own."""

import pytest
from PIL import Image

from embedder.fetch import FetchError, check_url, is_public
from embedder.images import crop
from embedder.settings import SettingsError, load_settings


@pytest.mark.parametrize(
    "address",
    [
        "10.0.0.1",
        "172.16.5.4",
        "192.168.1.1",
        "127.0.0.1",
        "0.0.0.0",  # noqa: S104 (a test value, not a bind address)
        "169.254.169.254",  # cloud metadata
        "100.64.0.1",  # carrier-grade NAT
        "224.0.0.1",
        "::1",
        "fe80::1%eth0",
        "fdaa:0:1:a7b::2",  # Fly's private network
        "::ffff:10.0.0.1",  # IPv4-mapped
        "64:ff9b::a00:1",  # NAT64 of 10.0.0.1
        "2002:a00:1::",  # 6to4 of 10.0.0.1
        "::7f00:1",  # old IPv4-compatible form of 127.0.0.1
        "::ffff:0:a00:1",  # IPv4-translated 10.0.0.1
        "fec0::1",  # old site-local
        "ff02::1",
    ],
)
def test_private_and_special_addresses_are_not_public(address):
    assert not is_public(address)


@pytest.mark.parametrize(
    "address", ["93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::808:808"]
)
def test_internet_addresses_are_public(address):
    assert is_public(address)


def test_check_url_gives_host_and_port():
    hosts = frozenset({"img.example.com"})
    assert check_url("https://IMG.example.com/a.webp", hosts) == ("img.example.com", 443)
    assert check_url("https://img.example.com:8443/a.webp", hosts) == ("img.example.com", 8443)
    with pytest.raises(FetchError):
        check_url("https://img.example.com.evil.com/a.webp", hosts)


@pytest.mark.parametrize(
    ("box", "size"),
    [
        ((0, 0, 1, 1), (10, 10)),
        ((0, 0, 0.5, 0.5), (5, 5)),
        ((0.999, 0.999, 1, 1), (1, 1)),
        ((0.33, 0.33, 0.34, 0.34), (1, 1)),
        # 2.5 → 7.5 px: half-covered edge pixels are kept.
        ((0.25, 0, 0.75, 0.1), (6, 1)),
    ],
)
def test_crop_cuts_the_box_and_is_never_empty(box, size):
    assert crop(Image.new("RGB", (10, 10)), *box).size == size


def test_settings_never_show_the_secret():
    settings = load_settings({"EMBEDDER_SECRET": "k" * 40, "EMBEDDER_IMAGE_HOSTS": "a.example"})
    assert "k" * 40 not in repr(settings)


def test_settings_need_a_long_secret_and_photo_hosts():
    good = {"EMBEDDER_SECRET": "k" * 32, "EMBEDDER_IMAGE_HOSTS": " Pub-1.r2.dev , img.example.com"}
    settings = load_settings(good)
    assert settings.image_hosts == {"pub-1.r2.dev", "img.example.com"}
    with pytest.raises(SettingsError):
        load_settings({**good, "EMBEDDER_SECRET": "k" * 31})
    with pytest.raises(SettingsError):
        load_settings({**good, "EMBEDDER_IMAGE_HOSTS": " , "})
