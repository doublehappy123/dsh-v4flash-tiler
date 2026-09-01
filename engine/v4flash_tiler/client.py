"""DeepSeek v4Flash vision client with automatic large-image tiling."""

from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import requests
from PIL import Image

from .config import DEFAULT_CONFIG, TilerConfig
from .tiler import (
    Tile,
    encode_image_data_url,
    estimate_tile_tokens,
    should_tile,
    split_image,
)


@dataclass
class AnalysisResult:
    """Result returned by the plugin."""

    text: str
    tiled: bool
    tile_count: int = 1
    image_count: int = 1
    estimated_tokens: int = 0


class DeepSeekVisionClient:
    """Minimal OpenAI-compatible DeepSeek client specialized for image analysis."""

    def __init__(
        self,
        api_key: str | None = None,
        config: TilerConfig | None = None,
        base_url: str | None = None,
        model: str | None = None,
    ) -> None:
        self.api_key = api_key or os.environ.get("DEEPSEEK_API_KEY", "")
        self.config = config or DEFAULT_CONFIG
        if base_url is not None:
            self.config.base_url = base_url.rstrip("/")
        if model is not None:
            self.config.model = model

    def analyze_image(
        self,
        image_path: str | Path,
        prompt: str = "请描述这张图片的主要内容，并识别其中的文字。",
        mode: str | None = None,
        detail: str | None = None,
        dry_run: bool = False,
        per_tile: bool | None = None,
    ) -> AnalysisResult | dict[str, Any]:
        """Analyze an image, automatically tiling oversized images if enabled."""
        config = self.config
        if mode is not None or detail is not None:
            config = replace(
                config,
                mode=mode if mode is not None else config.mode,
                detail=detail if detail is not None else config.detail,
            )
        if per_tile is not None:
            config = replace(config, per_tile_requests=per_tile)
        config.validate()

        image_path = Path(image_path)
        if not image_path.exists():
            raise FileNotFoundError(f"image not found: {image_path}")

        with Image.open(image_path) as img:
            image = img.convert("RGB")

        tiled = should_tile(image, config, file_size=image_path.stat().st_size)

        # save-token mode: never tile, and optionally shrink the image before
        # sending so the payload is smaller.
        if config.mode == "save-token" and not tiled:
            image = self._downscale_for_save_token(image)
            config = replace(config, detail="low")

        if tiled:
            tiles = split_image(image, config)
            return self._analyze_tiles(
                tiles=tiles,
                image_path=image_path,
                prompt=prompt,
                config=config,
                dry_run=dry_run,
            )

        return self._analyze_single(
            image=image,
            image_path=image_path,
            prompt=prompt,
            config=config,
            dry_run=dry_run,
        )

    def _analyze_single(
        self,
        image: Image.Image,
        image_path: Path,
        prompt: str,
        config: TilerConfig,
        dry_run: bool,
    ) -> AnalysisResult | dict[str, Any]:
        image_url = encode_image_data_url(image, quality=config.jpeg_quality)
        content = [
            {"type": "text", "text": prompt},
            {
                "type": "image_url",
                "image_url": {
                    "url": image_url,
                    "detail": config.detail,
                },
            },
        ]

        if dry_run:
            return {
                "mode": config.mode,
                "tiled": False,
                "image_count": 1,
                "detail": config.detail,
                "estimated_tokens": 384,
                "content_blocks": len(content),
            }

        text = self._request(content)
        return AnalysisResult(
            text=text,
            tiled=False,
            tile_count=1,
            image_count=1,
            estimated_tokens=384,
        )

    def _analyze_tiles(
        self,
        tiles: list[Tile],
        image_path: Path,
        prompt: str,
        config: TilerConfig,
        dry_run: bool,
    ) -> AnalysisResult | dict[str, Any]:
        if len(tiles) > config.max_images_per_request:
            raise ValueError(
                f"tile count {len(tiles)} exceeds max_images_per_request "
                f"({config.max_images_per_request})"
            )

        estimated = estimate_tile_tokens(len(tiles))

        if config.per_tile_requests:
            if dry_run:
                return {
                    "mode": config.mode,
                    "tiled": True,
                    "tile_count": len(tiles),
                    "image_count": len(tiles),
                    "detail": config.detail,
                    "estimated_tokens": estimated,
                    "per_tile_requests": True,
                }

            parts: list[str] = []
            for tile in tiles:
                tile_url = encode_image_data_url(tile.image, quality=config.jpeg_quality)
                prompt_with_index = (
                    f"{prompt}\n"
                    f"这是原图分块中的第 {tile.index + 1} 块，"
                    f"坐标范围 {tile.bbox}。请分析这一块的内容。"
                )
                content = [
                    {"type": "text", "text": prompt_with_index},
                    {
                        "type": "image_url",
                        "image_url": {"url": tile_url, "detail": config.detail},
                    },
                ]
                parts.append(self._request(content))

            text = "\n\n".join(parts)
            return AnalysisResult(
                text=text,
                tiled=True,
                tile_count=len(tiles),
                image_count=len(tiles),
                estimated_tokens=estimated,
            )

        # Single request with all tiles in left-to-right, top-to-bottom order.
        content: list[dict[str, Any]] = [
            {
                "type": "text",
                "text": (
                    f"{prompt}\n\n"
                    f"原图较大，已按从左到右、从上到下的顺序切成 {len(tiles)} 块。"
                    "请逐块分析，最后给出一个完整的综合结果。"
                ),
            }
        ]
        for tile in tiles:
            tile_url = encode_image_data_url(tile.image, quality=config.jpeg_quality)
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": tile_url,
                        "detail": config.detail,
                    },
                }
            )

        if dry_run:
            return {
                "mode": config.mode,
                "tiled": True,
                "tile_count": len(tiles),
                "image_count": len(tiles),
                "detail": config.detail,
                "estimated_tokens": estimated,
                "content_blocks": len(content),
                "tile_bboxes": [tile.bbox for tile in tiles],
            }

        text = self._request(content)
        return AnalysisResult(
            text=text,
            tiled=True,
            tile_count=len(tiles),
            image_count=len(tiles),
            estimated_tokens=estimated,
        )

    def _request(self, content: list[dict[str, Any]]) -> str:
        if not self.api_key:
            raise ValueError("DEEPSEEK_API_KEY is not set")
        url = f"{self.config.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.config.model,
            "messages": [{"role": "user", "content": content}],
        }

        response = requests.post(
            url,
            headers=headers,
            json=payload,
            timeout=self.config.request_timeout,
        )
        response.raise_for_status()
        data = response.json()
        return data["choices"][0]["message"]["content"]

    @staticmethod
    def _downscale_for_save_token(image: Image.Image, max_side: int = 1024) -> Image.Image:
        if max(image.size) <= max_side:
            return image
        image = image.copy()
        image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
        return image

