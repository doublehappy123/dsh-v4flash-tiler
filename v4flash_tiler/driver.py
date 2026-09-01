"""JSON stdin/stdout driver used by the DSH plugin.

The DSH Host plugin invokes this module as::

    python -m v4flash_tiler.driver

with a JSON payload on stdin and receives a JSON result on stdout.

Analyze mode (default): call the DeepSeek vision API.

    payload: {
      "job": "analyze" | "tile" | null,
      "image_path": str,
      "prompt": str | null,
      "mode": "auto" | "always" | "never" | "save-token" | null,
      "detail": "low" | "high" | "original" | "auto" | null,
      "tile_size": int | null,
      "overlap": number | null,
      "max_tiles": int | null,
      "per_tile": bool | null,
      "dry_run": bool | null,
      "api_key": str | null,
    }

    result: the plan dict (dry_run) or
            {"text": str, "tiled": bool, "tile_count": int, ...}

Tile mode: split one in-memory image, no API call.

    payload: {
      "job": "tile",
      "image_b64": str,            # base64 of the source image bytes
      "tile_size": int | null,
      "overlap": number | null,
      "max_tiles": int | null,
      "jpeg_quality": int | null,
    }

    result: {
      "triggered": bool,           # false when the image is not oversized
      "tile_count": int,
      "tiles": [ {"data_b64": str, "media_type": "image/jpeg",
                  "width": int, "height": int, "bbox": [x0,y0,x1,y1]} ],
    }

The api_key is never echoed back.
"""

from __future__ import annotations

import base64
import io
import json
import sys

from PIL import Image

from .client import DeepSeekVisionClient
from .config import TilerConfig
from .tiler import encode_image_data_url, split_image

DEFAULT_PROMPT = "请描述这张图片的主要内容，并识别其中的文字。"


def _config(payload: dict) -> TilerConfig:
    return TilerConfig(
        mode=payload.get("mode") or "auto",
        detail=payload.get("detail") or "high",
        tile_size=int(payload.get("tile_size") or 1024),
        overlap=float(payload.get("overlap") if payload.get("overlap") is not None else 0.15),
        max_tiles=int(payload.get("max_tiles") or 9),
        per_tile_requests=bool(payload.get("per_tile") or False),
    )


def _load_image(image_b64: str) -> Image.Image:
    data = base64.b64decode(image_b64)
    with Image.open(io.BytesIO(data)) as img:
        return img.convert("RGB")


def _run_tile(payload: dict) -> dict:
    image = _load_image(payload["image_b64"])
    config = _config(payload)

    # The host half is the decision maker (it gate-keeps by its own threshold
    # before ever calling this job), so tile unconditionally here.
    tiles = split_image(image, config)
    quality = int(payload.get("jpeg_quality") or config.jpeg_quality)

    # Derive the grid (rows x cols) and per-tile (row, col) from bbox order:
    # split_image emits left-to-right, top-to-bottom.
    tops: list[int] = []
    lefts: list[int] = []
    for tile in tiles:
        x0, y0, _, _ = tile.bbox
        if y0 not in tops:
            tops.append(y0)
        if x0 not in lefts:
            lefts.append(x0)
    rows = len(tops)
    cols = len(lefts)

    out_tiles = []
    for tile in tiles:
        url = encode_image_data_url(tile.image, quality=quality)
        # url = "data:image/jpeg;base64,<payload>"
        data_b64 = url.split(",", 1)[1]
        x0, y0, x1, y1 = tile.bbox
        out_tiles.append(
            {
                "data_b64": data_b64,
                "media_type": "image/jpeg",
                "width": tile.width,
                "height": tile.height,
                "bbox": [x0, y0, x1, y1],
                "row": tops.index(y0),
                "col": lefts.index(x0),
            }
        )
    return {
        "triggered": True,
        "tile_count": len(out_tiles),
        "image_width": image.width,
        "image_height": image.height,
        "grid_rows": rows,
        "grid_cols": cols,
        "overlap": config.overlap,
        "tiles": out_tiles,
    }


def _run_analyze(payload: dict) -> dict:
    config = _config(payload)
    client = DeepSeekVisionClient(
        api_key=payload.get("api_key") or None,
        config=config,
    )
    result = client.analyze_image(
        image_path=payload["image_path"],
        prompt=payload.get("prompt") or DEFAULT_PROMPT,
        dry_run=bool(payload.get("dry_run") or False),
    )

    if isinstance(result, dict):
        return result
    return {
        "text": result.text,
        "tiled": result.tiled,
        "tile_count": result.tile_count,
        "image_count": result.image_count,
        "estimated_tokens": result.estimated_tokens,
    }


def main() -> int:
    payload = json.load(sys.stdin)

    try:
        if payload.get("job") == "tile":
            out = _run_tile(payload)
        else:
            out = _run_analyze(payload)
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - driver reports failures as JSON
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
