"""Quickstart example for v4flash-image-tiler."""

from v4flash_tiler import DeepSeekVisionClient, TilerConfig


def main() -> None:
    client = DeepSeekVisionClient()  # reads DEEPSEEK_API_KEY

    config = TilerConfig(
        mode="auto",       # auto / always / never / save-token
        detail="high",
        tile_size=1024,
        overlap=0.15,
        max_tiles=9,
    )

    # Dry run: see how the image would be processed without calling the API.
    plan = client.analyze_image(
        image_path="example_large.png",
        prompt="请分析这张图片。",
        dry_run=True,
    )
    print(plan)

    # Real call.
    result = client.analyze_image(
        image_path="example_large.png",
        prompt="请分析这张图片，提取其中的关键信息和文字。",
    )
    print(result.text)


if __name__ == "__main__":
    main()
