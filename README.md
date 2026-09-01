# dsh-v4flash-tiler

DeepSeek v4Flash 视觉模型的**大图自动分块插件**：把聊天里发送的超大图片自动切成多块高清图块（带行列坐标标注）再送入模型，让细小文字、图标、图表细节不再被 800×800 的自动缩放抹掉。

## 背景

DeepSeek 视觉模型接收图片时会自动缩放：大于约 800×800 等效像素的图片会被整体缩小，单张图片 token 上限约 384 —— 超大截图、密集小字、图表细节会因此丢失。本插件通过把大图切成**最多 9 块、带 15% 重叠**的小图块，让每一块都保持原始清晰度，并给模型提供**行列网格、每块坐标、重叠说明**，使其能按图块坐标"拼回"整图；一次发多张图时，每张原图的块自成一组并明确禁止跨图混拼。

## 组成

| 路径 | 说明 |
|---|---|
| `v4flash_tiler/` | Python 引擎：图片检测/切块/编码（Pillow），含命令行与 pure-tile 驱动 |
| `dsh-v4flash-tiler/` | DSH 插件（profile bundle）：宿主 `agent/pre-step` 拦截，发图即自动分块 |

## 安装

### 1. Python 引擎（DSH 插件依赖它）

```bash
pip install -e .
# API Key（仅 CLI 手动分析模式需要；自动分块不调 API）
export DEEPSEEK_API_KEY="..."
```

### 2. DSH 插件（profile bundle）

官方发布说明（[docs/user/develop/basic/publish](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md)）允许两种安装形态：

```bash
# GitHub 直装（纯 JS 插件无需构建，无需 allowBuilds 授权）
dsh plugin --profile web add github:doublehappy123/dsh-v4flash-tiler

# 或本地 checkout 安装
dsh plugin --profile web add ./dsh-v4flash-tiler
```

`dsh plugin add` 会初始化 profile（若需）、把组合包追加进 `dsh.profile.bundles`，重启 DSH 即生效。插件内以 `python -m v4flash_tiler.driver` 调用引擎，Python 引擎需先 `pip install -e .`（或 `pip install .`）。

> 每个 DSH profile 插件栈独立，需按 profile 分别安装（web / desktop 等）。

## 使用

- **聊天自动分块**（DSH 内）：直接发送任意图片，边长 > 1024px 的图自动切块并标注行列；小图原样直通；失败自动回退原图并在消息中说明原因。
- **命令行**：
  ```bash
  v4flash-tiler --image screenshot.png --mode auto --dry-run      # 只看分块计划
  v4flash-tiler --image screenshot.png --prompt "提取全部文字"    # 调 API 分析
  ```
- **Python API**：
  ```python
  from v4flash_tiler import DeepSeekVisionClient, TilerConfig
  result = DeepSeekVisionClient().analyze_image("large.png", prompt="分析这张图")
  print(result.text)
  ```

## 配置要点

- 阈值：任一边 > 1024px 即分块；单图最多 9 块（1 024px 边长、15% 重叠、JPEG 质量 90）
- 每条消息的图块总数受 DSH 附件限制保护，超限的图片保持原图直通
- 每块输入 token 约 384，9 块 ≈ 3400 token/图

## 开发

```bash
pip install -e .
python -m v4flash_tiler.driver   # stdin JSON -> stdout JSON（analyze / tile 两种 job）
python -m pytest tests/          # 单元测试
```

## License

MIT
