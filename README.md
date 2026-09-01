# dsh-v4flash-tiler

DeepSeek 视觉模型的**大图自动分块插件**：在聊天里发送超大图片时，宿主自动把它切成多块高清图块（带行列坐标标注）再送入模型，让细小文字、图标、图表细节不再被 800×800 的自动缩放抹掉。本仓库根目录即官方发布说明（[publish.zh.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md)）所述的**组合包**，可直接 `dsh plugin add` 安装；Python 切块引擎位于 [`engine/`](engine/)。

## 背景

DeepSeek 视觉模型接收图片时会自动缩放（大于约 800×800 等效像素即整体缩小，单张 token 上限约 384），超大截图、密集小字、图表细节因此丢失。本插件把大图切成**最多 9 块、15% 重叠**的小图块，让每块保持原始清晰度，并向模型提供**网格、每块（行,列）坐标、重叠说明**，使其能按坐标拼回整图；一条消息多张图时，每张原图的块自成一组并明确禁止跨图混拼。

## 安装

```bash
# 1) Python 引擎（插件在运行时调用 python -m v4flash_tiler.driver）
pip install -e ./engine        # 或 pip install ./engine

# 2) 组合包 → profile（纯 JS 无需构建，GitHub 直装即可）
dsh plugin --profile web add github:doublehappy123/dsh-v4flash-tiler
# 或本地：dsh plugin --profile web add ./dsh-v4flash-tiler

# 3) 重启 DSH（该 profile）
```

> 每个 profile 插件栈独立，需按 profile 分别安装。CLI 手动分析模式额外需要 `DEEPSEEK_API_KEY`；自动分块不调用 API。

## 使用

- **聊天自动分块**：直接发送任意图片。任一边 > 1024px 自动切块并标注行列；小图原样直通；失败自动回退原图并在消息中说明原因。
- **命令行**（`engine/` 安装后）：
  ```bash
  v4flash-tiler --image screenshot.png --mode auto --dry-run      # 只看分块计划
  v4flash-tiler --image screenshot.png --prompt "提取全部文字"    # 调 API 分析
  ```
- **Python API**：
  ```python
  from v4flash_tiler import DeepSeekVisionClient
  result = DeepSeekVisionClient().analyze_image("large.png", prompt="分析这张图")
  ```

## 仓库结构（与官方发布说明一致）

```text
package.json            # 组合包 manifest：dsh.bundle.patch
cordis.patch.yml        # 插件行（id: v4flash-tiler）
lib/index.js            # Host 半边：agent/pre-step 自动分块
engine/                 # Python 引擎（v4flash_tiler 包 + CLI + 测试）
```

## 配置要点

- 阈值：任一边 > 1024px 即分块；单图最多 9 块（1024px、15% 重叠、JPEG 质量 90）
- 每条消息图块总数受 DSH 附件上限保护，超限图片保持原图直通
- 每块输入 token 约 384，9 块 ≈ 3400 token/图

## License

MIT
