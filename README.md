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

## 分块开关（独立于视觉助手）

本插件有**自己的**开关，配置文件在 `~/.dsh/v4flash-tiler/config.json`，与 `dsh-vision-helper` 的
`vision-route` 开关**互不影响**：

| mode | 行为 |
|---|---|
| `auto`（默认） | 只给**不能看图**的模型分块 |
| `off` | 永不分块 |
| `always` | 所有超尺寸图都分块（即使模型能看图） |

在对话里用工具 `tiler_route(mode=...)` 查看或切换；不带参数则只读当前状态。

> 2026-10-08 之前，本插件读取的是 `~/.dsh/vision-helper/config.json` 里的同一个 `mode`，
> 导致「给能看图的模型强制分块」会连带打开视觉助手的路由（反之亦然）。现已分离：
> 首次读取时若本插件尚无配置，会自动从旧共享开关**迁移一次** `mode`，之后不再读取该文件。
> 想让小字不被服务端降采样糊掉时，用 `tiler_route(mode="always")`——它不会再影响 `vision_route`。

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

## 自动打开生成图片（当前默认关闭）

插件可以监听 `tools/result`：当某个工具执行成功并返回/生成了图片文件时，用系统默认图片查看器自动打开该图片。**该监听器当前默认禁用**（原因见下），需在 `lib/index.js` 的 `apply()` 里重新启用。

- 支持从工具参数、结果文本、结构化 `value`/`meta` 和 DSH 图片附件中提取图片路径；
- 仅打开存在且扩展名为 `.png/.jpg/.jpeg/.webp/.gif/.bmp/.svg` 的图片；
- 自动跳过 `read_image`、`read`、`view` 等只读工具，避免打开已有图片造成打扰；
- 每个路径在同一插件生命周期内只打开一次；
- 若宿主没有可用的 shell 或打开失败，只记录日志，不影响对话/工具执行。

> 禁用于 2026-09-03：该监听器会打开**任何**工具结果中出现的图片路径（`pwsh` 输出、分析文本等都会被正则扫到），导致系统里堆积大量图片查看器窗口，并在重启后被 Windows 恢复。重新启用前请先限定为**图片生成类工具**的白名单。

## 安全的图片发送工具（当前默认关闭）

插件包含一个 `chat_send_image` 工具，供模型在生图后把图片以附件形式发到对话中。**该工具当前默认未注册**（`apply()` 中已注释），需显式调用 `registerChatSendImageTool(ctx)` 启用。

关键点：

- 使用 `exec.deferContext()` 注入 **user 消息 / next-step context**；
- **不允许把图片写到 `assistant` 消息里**；
- DeepSeek chat-completions 不支持 assistant 消息携带图片，否则会把整个会话历史打坏；
- 工具执行成功后返回附件元数据，图片会出现在下一条模型上下文中，用户也能直接看到。

## 修复已损坏的会话

如果当前会话已经因为“assistant 消息带图片”损坏，可以使用仓库里的修复脚本：

```bash
python scripts/repair_session.py \
  session.jsonl \
  session.repaired.jsonl
```

该脚本会把所有 `assistant/message` 里的图片块替换成文本占位符，同时保留其余会话内容。修复后的 `session.repaired.jsonl` 可以配合原 `media/` 目录重新打包/导入。

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

## 兼容性

- 自动分块只改写模型输入中的 `user` 图片，不影响聊天记录中原图展示。
- DeepSeek chat-completions **不允许** `assistant` 消息携带图片。`chat_send_image` 工具已改为通过 `exec.deferContext()` 注入 next-step user context，避免再产生损坏会话的 assistant 图片消息。
- 如果会话已经损坏，请使用 `scripts/repair_session.py` 修复历史中的 assistant 图片块。

## License

MIT
