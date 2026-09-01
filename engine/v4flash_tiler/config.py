"""Configuration for the v4Flash image tiler plugin."""

from dataclasses import dataclass, field
from typing import Literal


@dataclass
class TilerConfig:
    """Runtime configuration.

    mode:
        auto       - tile only when the image is considered oversized
        always     - always tile (mostly useful for testing/forced detail)
        never      - never tile, send the image directly
        save-token - never tile; the client may downscale and use low detail
    """

    mode: Literal["auto", "always", "never", "save-token"] = "auto"
    detail: Literal["low", "high", "original", "auto"] = "high"
    tile_size: int = 1024
    overlap: float = 0.15
    max_tiles: int = 9

    # Thresholds used by mode="auto".
    max_image_side: int = 4096
    max_pixels: int = 8_000_000
    max_file_size: int = 10 * 1024 * 1024

    # Encoding / API options.
    jpeg_quality: int = 90
    request_timeout: int = 120
    base_url: str = "https://api.deepseek.com"
    model: str = "deepseek-v4-flash-vision-exp"
    max_images_per_request: int = 600

    # If True, each tile is sent as a separate chat request and the texts are
    # concatenated. This is useful for OCR or per-region analysis.
    per_tile_requests: bool = False

    def validate(self) -> None:
        if self.tile_size <= 0:
            raise ValueError("tile_size must be positive")
        if not 0 <= self.overlap < 1:
            raise ValueError("overlap must be in [0, 1)")
        if self.max_tiles <= 0:
            raise ValueError("max_tiles must be positive")
        if self.mode not in {"auto", "always", "never", "save-token"}:
            raise ValueError(f"unknown mode: {self.mode!r}")
        if self.detail not in {"low", "high", "original", "auto"}:
            raise ValueError(f"unknown detail: {self.detail!r}")


DEFAULT_CONFIG = TilerConfig()
