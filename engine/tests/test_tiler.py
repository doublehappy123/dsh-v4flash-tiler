"""Tests for the image tiler plugin."""

from __future__ import annotations

from PIL import Image

from v4flash_tiler.config import TilerConfig
from v4flash_tiler.tiler import (
    encode_image_data_url,
    should_tile,
    split_image,
)


def _image(width: int, height: int) -> Image.Image:
    return Image.new("RGB", (width, height), color=(255, 0, 0))


def test_should_tile_auto_uses_pixel_threshold() -> None:
    config = TilerConfig(mode="auto", max_image_side=4096, max_pixels=8_000_000)
    assert should_tile(_image(5000, 100), config) is True
    assert should_tile(_image(2000, 1000), config) is False
    assert should_tile(_image(3000, 3000), config) is True  # 9M pixels


def test_should_tile_never_and_save_token() -> None:
    assert should_tile(_image(8000, 8000), TilerConfig(mode="never")) is False
    assert should_tile(_image(8000, 8000), TilerConfig(mode="save-token")) is False


def test_split_image_returns_tiles_within_bounds() -> None:
    config = TilerConfig(tile_size=1024, overlap=0.15, max_tiles=100)
    image = _image(3000, 2000)
    tiles = split_image(image, config)

    assert len(tiles) > 1
    for tile in tiles:
        left, top, right, bottom = tile.bbox
        assert 0 <= left < right <= 3000
        assert 0 <= top < bottom <= 2000


def test_split_image_respects_max_tiles() -> None:
    config = TilerConfig(tile_size=512, overlap=0.0, max_tiles=3)
    tiles = split_image(_image(2000, 2000), config)
    assert 0 < len(tiles) <= 3


def test_encode_image_data_url() -> None:
    url = encode_image_data_url(_image(64, 64), quality=80)
    assert url.startswith("data:image/jpeg;base64,")
