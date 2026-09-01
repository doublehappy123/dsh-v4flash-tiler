"""Image tiling helpers for the v4Flash plugin."""

from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass
from typing import Iterable

from PIL import Image

from .config import TilerConfig


@dataclass(frozen=True)
class Tile:
    """One cropped region of the original image."""

    index: int
    image: Image.Image
    bbox: tuple[int, int, int, int]

    @property
    def width(self) -> int:
        return self.bbox[2] - self.bbox[0]

    @property
    def height(self) -> int:
        return self.bbox[3] - self.bbox[1]


def should_tile(
    image: Image.Image,
    config: TilerConfig,
    file_size: int | None = None,
) -> bool:
    """Return True when the image should be tiled before sending to the model."""
    if config.mode == "never" or config.mode == "save-token":
        return False
    if config.mode == "always":
        return True

    width, height = image.size
    if max(width, height) > config.max_image_side:
        return True
    if width * height > config.max_pixels:
        return True
    if file_size is not None and file_size > config.max_file_size:
        return True
    return False


def split_image(
    image: Image.Image,
    config: TilerConfig | None = None,
) -> list[Tile]:
    """Split an image into a grid of overlapping tiles.

    The returned tiles are ordered left-to-right, top-to-bottom so the model
    can be told the ordering unambiguously.

    The grid size is derived from ``tile_size``, but is automatically reduced
    when necessary so the total number of tiles does not exceed
    ``config.max_tiles``. The whole image is always covered.
    """
    config = config or TilerConfig()
    config.validate()

    width, height = image.size

    # Preferred grid derived from the desired tile size.
    cols = max(1, math.ceil(width / config.tile_size))
    rows = max(1, math.ceil(height / config.tile_size))

    if cols * rows > config.max_tiles:
        cols, rows = _choose_grid(
            width=width,
            height=height,
            max_tiles=config.max_tiles,
        )

    step_x = width / cols
    step_y = height / rows

    overlap_x = int(step_x * config.overlap) if config.overlap else 0
    overlap_y = int(step_y * config.overlap) if config.overlap else 0
    tile_w = math.ceil(step_x + overlap_x)
    tile_h = math.ceil(step_y + overlap_y)

    tiles: list[Tile] = []
    index = 0

    for row in range(rows):
        top = round(row * step_y)
        for col in range(cols):
            left = round(col * step_x)
            right = min(width, left + tile_w)
            bottom = min(height, top + tile_h)

            if right <= left or bottom <= top:
                continue

            crop = image.crop((left, top, right, bottom))
            tiles.append(
                Tile(index=index, image=crop, bbox=(left, top, right, bottom))
            )
            index += 1

    return tiles


def _choose_grid(
    width: int,
    height: int,
    max_tiles: int,
) -> tuple[int, int]:
    """Choose a (cols, rows) grid whose area is within max_tiles.

    The grid aspect ratio is kept as close as possible to the image aspect
    ratio. When multiple choices are equally close, the one with more tiles is
    preferred because smaller tiles preserve more detail.
    """
    image_aspect = width / height
    best: tuple[float, int, int] | None = None

    for cols in range(1, max_tiles + 1):
        rows = max(1, max_tiles // cols)
        if cols * rows > max_tiles:
            continue

        grid_aspect = cols / rows
        # Log-aspect distance handles both landscape and portrait naturally.
        score = abs(math.log(grid_aspect / image_aspect))
        tile_count = cols * rows

        if best is None or score < best[0] or (score == best[0] and tile_count > best[2]):
            best = (score, cols, rows)

    if best is None:
        return 1, 1

    return best[1], best[2]


def encode_image_data_url(
    image: Image.Image,
    quality: int = 90,
    image_format: str = "JPEG",
) -> str:
    """Encode a PIL image as a data URL usable by DeepSeek's image API."""
    buffer = io.BytesIO()

    if image_format.upper() == "JPEG" and image.mode in ("RGBA", "LA", "P"):
        # JPEG has no alpha; flatten onto white for predictable output.
        rgba = image.convert("RGBA")
        background = Image.new("RGB", rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.split()[-1])
        image = background
    else:
        image = image.convert("RGB")

    image.save(buffer, format=image_format, quality=quality)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    mime = "image/jpeg" if image_format.upper() == "JPEG" else f"image/{image_format.lower()}"
    return f"data:{mime};base64,{encoded}"


def encode_tiles(
    tiles: Iterable[Tile],
    config: TilerConfig | None = None,
) -> list[str]:
    """Return data URLs for a sequence of tiles."""
    config = config or TilerConfig()
    return [encode_image_data_url(tile.image, quality=config.jpeg_quality) for tile in tiles]


def estimate_tile_tokens(num_tiles: int) -> int:
    """Rough token estimate based on the documented 384-token per-image cap."""
    return num_tiles * 384
