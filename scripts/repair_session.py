#!/usr/bin/env python3
"""Repair a DSH session.jsonl exported from a corrupted conversation.

The corruption is caused by tool/plugin code that appended an image attachment
inside an *assistant* message. DeepSeek chat-completions only accepts images in
user messages, so the adapter rejects the whole conversation with:

    The DeepSeek chat-completions adapter cannot represent image content in a
    assistant message.

This script rewrites such assistant image blocks into short text placeholders.
The rest of the session log is preserved.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def _has_image(blocks) -> bool:
    for block in blocks or []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "image":
            return True
        if block.get("type") == "tool-result" and isinstance(block.get("content"), list):
            if _has_image(block["content"]):
                return True
    return False


def _replace_images(blocks):
    out = []
    for block in blocks or []:
        if not isinstance(block, dict):
            out.append(block)
            continue
        if block.get("type") == "image":
            ref = block.get("attachment") or {}
            name = ref.get("name", "图片附件")
            size = ""
            if isinstance(ref.get("width"), int) and isinstance(ref.get("height"), int):
                size = f" ({ref['width']}{ref['height']})"
            out.append({
                "type": "text",
                "text": f"[{name}{size}：图片附件已修复为文本占位，不再以 assistant 图片发送]",
            })
        elif block.get("type") == "tool-result" and isinstance(block.get("content"), list):
            new_block = dict(block)
            new_block["content"] = _replace_images(block["content"])
            out.append(new_block)
        else:
            out.append(block)
    return out


def repair_file(input_path: Path, output_path: Path) -> int:
    count = 0
    with open(input_path, encoding="utf-8") as f:
        lines = f.readlines()

    repaired_lines = []
    for line in lines:
        line = line.rstrip("\n")
        if not line:
            repaired_lines.append("")
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            repaired_lines.append(line)
            continue

        data = event.get("data") or {}
        if event.get("type") == "assistant/message":
            message = data.get("message") or {}
            content = message.get("content")
            if isinstance(content, list) and _has_image(content):
                new_content = _replace_images(content)
                new_message = dict(message)
                new_message["content"] = new_content
                new_data = dict(data)
                new_data["message"] = new_message
                event["data"] = new_data
                count += 1

        repaired_lines.append(json.dumps(event, ensure_ascii=False))

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(repaired_lines) + "\n")

    return count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="Original session.jsonl")
    parser.add_argument("output", type=Path, help="Repaired session.jsonl")
    args = parser.parse_args()

    count = repair_file(args.input, args.output)
    print(f"repaired {count} assistant message(s) with image content")
    print(f"written: {args.output}")


if __name__ == "__main__":
    main()
