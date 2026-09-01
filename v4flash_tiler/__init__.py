"""v4Flash image tiler plugin.

A small utility that detects oversized images, tiles them into smaller
image blocks, and sends them to DeepSeek's vision model
(deepseek-v4-flash-vision-exp) to preserve fine details.
"""

from .client import DeepSeekVisionClient
from .config import DEFAULT_CONFIG, TilerConfig
from .tiler import Tile, encode_image_data_url, should_tile, split_image

__all__ = [
    "DEFAULT_CONFIG",
    "TilerConfig",
    "DeepSeekVisionClient",
    "Tile",
    "should_tile",
    "split_image",
    "encode_image_data_url",
]
