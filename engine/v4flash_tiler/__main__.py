"""Command-line entry point for the v4Flash image tiler plugin."""

from __future__ import annotations

import argparse
import json
import sys

from .client import DeepSeekVisionClient
from .config import DEFAULT_CONFIG, TilerConfig


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="v4flash-tiler",
        description="Analyze images with DeepSeek v4Flash, tiling oversized images for detail.",
    )
    parser.add_argument("--image", required=True, help="Path to the input image")
    parser.add_argument(
        "--prompt",
        default="请描述这张图片的主要内容，并识别其中的文字。",
        help="Text prompt sent with the image(s)",
    )
    parser.add_argument("--api-key", default=None, help="DeepSeek API key (or DEEPSEEK_API_KEY env)")
    parser.add_argument("--base-url", default=DEFAULT_CONFIG.base_url, help="API base URL")
    parser.add_argument("--model", default=DEFAULT_CONFIG.model, help="Model name")
    parser.add_argument(
        "--mode",
        choices=["auto", "always", "never", "save-token"],
        default=DEFAULT_CONFIG.mode,
        help="Tiling mode",
    )
    parser.add_argument(
        "--detail",
        choices=["low", "high", "original", "auto"],
        default=DEFAULT_CONFIG.detail,
        help="Image detail level",
    )
    parser.add_argument("--tile-size", type=int, default=DEFAULT_CONFIG.tile_size)
    parser.add_argument("--overlap", type=float, default=DEFAULT_CONFIG.overlap)
    parser.add_argument("--max-tiles", type=int, default=DEFAULT_CONFIG.max_tiles)
    parser.add_argument("--per-tile", action="store_true", help="Send each tile as a separate request")
    parser.add_argument("--dry-run", action="store_true", help="Show the plan without calling the API")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    config = TilerConfig(
        mode=args.mode,
        detail=args.detail,
        tile_size=args.tile_size,
        overlap=args.overlap,
        max_tiles=args.max_tiles,
        base_url=args.base_url,
        model=args.model,
        per_tile_requests=args.per_tile,
    )

    try:
        client = DeepSeekVisionClient(api_key=args.api_key, config=config)
        result = client.analyze_image(
            image_path=args.image,
            prompt=args.prompt,
            dry_run=args.dry_run,
        )

        if args.dry_run:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            assert not isinstance(result, dict)  # dry_run never reaches here
            print(result.text)
        return 0
    except Exception as exc:  # noqa: BLE001 - CLI should show a readable error
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
