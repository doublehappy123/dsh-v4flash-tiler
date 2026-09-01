# dsh-v4flash-tiler（DSH 插件半边）

DSH profile bundle：在会话的 `agent/pre-step` 瀑布上挂一个根监听器，**用户发送的图片在进入模型前自动分块**。

## 行为

- 图片任一边 > 1024px → 自动切成最多 9 块（1024px、15% 重叠），消息中注入行/列坐标标签与拼接说明，模型按块坐标拼回整图
- 同一条消息多张图 → 每张原图的块自成一组（「第 X 张原图」分组头 + 跨图禁混拼提示）
- 小图（≤1024px）→ 原样直通
- 切块失败 → 回退原图，并在消息里写明原因，绝不阻塞对话
- 引擎调用：`python -m v4flash_tiler.driver`（本仓库根目录的 Python 包），base64 进出、无临时文件；沙箱策略经 `sandboxPolicy` 服务按会话解析

## 安装

官方发布说明（[deepseek-harness docs/user/develop/basic/publish](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.zh.md)）：

```bash
# 1) 安装 Python 引擎（仓库根目录）
pip install -e .

# 2) 安装组合包到 profile（示例 web；纯 JS 无构建，git 直装即可）
dsh plugin --profile web add github:doublehappy123/dsh-v4flash-tiler
# 或本地 checkout：dsh plugin --profile web add ./dsh-v4flash-tiler

# 3) 重启 DSH（该 profile）
```

## 结构

```text
dsh-v4flash-tiler/
  package.json       # dsh.bundle.patch 声明 + 导出
  cordis.patch.yml   # loader 插入行（id: v4flash-tiler）
  lib/index.js       # Host 半边：pre-step 自动分块（唯一职责）
```

## License

MIT
