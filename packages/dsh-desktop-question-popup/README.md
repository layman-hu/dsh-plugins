# @layman-hu/dsh-desktop-question-popup

A Windows desktop popup for DeepSeek Harness (DSH): when the agent needs a
choice, the same question also appears in a bottom-right, always-on-top window.
Whichever side answers first — the popup or the DSH UI — ends the other.

<!-- EN -->

## Overview

DSH's `ask_user_question` tool normally waits inside the DSH window. This bundle
adds a second, native-feeling surface for it:

- the question is rendered in a small dark window at the bottom-right corner of
  the primary screen, above other windows;
- the window shows the same questions, options, custom-answer field, and
  countdown as the DSH card;
- submitting from the popup returns that answer to the model and the DSH card
  disappears; answering in DSH hides the popup;
- closing the popup (button or Esc) produces **no answer** — DSH keeps waiting,
  and you can still answer there.

The popup is opened lazily on the first question (helper process + Edge `--app`
window), hidden while idle, and torn down when the bundle is disabled.

## Why timed mode (the shadowed tool)

DSH ships `ask_user_question` inside an agent preset in two modes:

- **legacy** — blocking; the DSH card is removed only when the user acts in the
  DSH UI. A popup answer can therefore never close the card.
- **timed** — the request carries `{ callId, timed: true }`, the web client holds
  the wait through an `attachWait` stream, and the host closing that wait is what
  removes the card.

Because DSH's shipped row sits inside a preset that a profile patch cannot reach
(and an already-mounted agent is not rebuilt), this bundle registers its own
timed `ask_user_question` into each live agent's tools layer, where scoped tools
shadow the inherited preset row. The model-facing contract (description,
parameters including `timeout`, output schema, pending notice) is copied field
by field from DSH's timed tool; see `NOTICE`.

With the bundle disabled, the shipped legacy tool is used again — no
configuration to revert.

## Requirements

- Windows 10 or 11 (x64/arm64).
- Microsoft Edge installed (used only as a rendering host for the popup page).
- Windows PowerShell 5.1 (built in) or PowerShell 7 (`pwsh`) for the window
  helper.
- DSH `>=0.2.2-rc.1 <0.3.0` (pinned in `engines.dsh`).

## Install

### 1. Through the plugin market index

Add this index URL in DSH (Discover / Settings → plugins):

```
https://raw.githubusercontent.com/layman-hu/dsh-plugins/main/index.json
```

Then install **Desktop question popup** from the list.

### 2. Through `plugin_manager` with an explicit spec

Git (recommended until the package is published on npm). Replace `<commit>` with
the 40-hex commit from `index.json` / a release tag:

```
plugin_manager install_bundle  target=git+https://github.com/layman-hu/dsh-plugins.git#<commit>&path:/packages/dsh-desktop-question-popup
```

npm (after the package is published):

```
plugin_manager install_bundle  target=@layman-hu/dsh-desktop-question-popup@0.1.0
```

Both paths mount the bundle's `cordis.patch.yml` (one host-plane row). No preset
or `tool-ask-user` edit is required.

## Configuration

All fields are optional; the bundle patch uses the defaults.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps the timed tool but never shows the popup |
| `shadowTimedTool` | `true` | `false` skips the shadowed tool (popup only for requests that are already timed) |
| `timeout` | `120` | default `timeout` value in seconds for the shadowed tool |
| `width` | `460` | window width in DIP |
| `minHeight` / `maxHeight` | `240` / `620` | content height clamp in DIP |
| `margin` | `12` | right/bottom margin from the work area, in DIP |
| `edgePath` | auto-detected | `msedge.exe` path |
| `shellPath` | auto-detected | helper host (`pwsh.exe` first, then `powershell.exe`) |
| `userDataDir` | `%TEMP%\dsh-question-popup\edge-profile` | dedicated Edge profile |
| `logFile` | `%TEMP%\dsh-question-popup\popup.log` | one-line diagnostics |
| `debugPort` | `0` | non-zero exposes Chromium DevTools on that loopback port (development only) |

## Behavior and semantics

| Case | Behavior |
|---|---|
| `timeout >= 1` (default from config) | `askTimed`; the popup participates; first answer wins |
| `timeout = -1` (model asks for a blocking answer) | shipped blocking path, **no popup**: without `wait.timed` the DSH card cannot be removed after a popup answer |
| non-timed `user-questions/request` | passed through to DSH unchanged |
| popup unavailable (not Windows, no Edge, helper failure, page not ready) | logged once, all questions take the native path; never blocks and never throws at the tool |
| user closes the popup | no answer is produced; DSH keeps waiting and remains answerable |
| a second question while a popup is open | the second one uses the native dialog (no stacked windows) |
| timed wait expires | tool returns `{ pending: true, callId, message }`; popup hides |
| bundle disabled/uninstalled | shadowed registration removed; the shipped legacy tool returns |

The default wait is 120 seconds; after that the tool returns `pending`, not a
skip. Requests from a delegated child agent are rejected by DSH itself
(`DELEGATED_CALLER`); this bundle does not change that boundary.

## Privacy and security

- The page is served by a loopback HTTP server on `127.0.0.1` with a random port
  and a random per-run token; every question/answer route requires the token.
- The popup runs in a **dedicated Edge profile** under
  `%TEMP%\dsh-question-popup\edge-profile`; your everyday browser profile,
  cookies, history, and extensions are never touched.
- No screen capture, no reading of other windows, no network access beyond
  loopback. The UI loads no CDN, no external font, no remote asset.
- Diagnostics never record question text or answers — only lifecycle lines
  (question count, window rect, state, call id).
- Cleanup kills only `msedge.exe` processes whose command line contains this
  bundle's dedicated profile directory; your own Edge windows are never touched.

## Known limitations

- **Windows only.** Non-Windows hosts skip the popup and keep the native flow.
- Requires Edge and PowerShell; without them the popup degrades to native.
- The shadowed tool depends on DSH's tool/agent internals (`dsh-tools` scoped
  layers, `user-questions` timed waits). It is pinned to
  `engines.dsh >=0.2.2-rc.1 <0.3.0`; a DSH upgrade outside that range may need a
  bundle update.
- `timeout: -1` deliberately does not use the popup (see the table above).
- The idle bundle keeps one Edge process and one PowerShell helper alive for
  fast popups (roughly 100–200 MB); they exit with DSH or when the bundle is
  disabled.

## Uninstall

- Disable or remove the bundle row in DSH (Plugins page / `plugin_manager`).
  Cleanup closes the loopback server, kills the helper, and stops the dedicated
  Edge process.
- The dedicated Edge profile and logs stay under `%TEMP%\dsh-question-popup\`;
  delete that directory to remove all local state.

## Troubleshooting

| Symptom | Check |
|---|---|
| No popup, DSH dialog still works | `%TEMP%\dsh-question-popup\popup.log` — look for `desktop popup unavailable, native questions only: <reason>` |
| `popup page did not become ready` | Edge installed? `edgePath` correct? another process using `debugPort`? |
| Popup shows but is not on top | Make sure `debugPort` is not set in production and no custom Edge flags are injected; topmost is asserted after the window is shown |
| Answering the popup leaves the DSH card open | The request was not timed (e.g. `timeout: -1`), or `shadowTimedTool` is `false` |
| Window stuck at an old size | Content height is re-reported after each render; check the page console via `debugPort` if you enabled it |

## Development

```powershell
cd packages/dsh-desktop-question-popup
node --test            # 76 offline tests (Node 24; do not pass a directory)
```

`tools/e2e-cdp.mjs` drives a real popup through Chromium DevTools (needs
`debugPort`): `--action answer --label <option>`, `--action dismiss`,
`--action observe`. It prints one JSON line with the DOM evidence and timestamps.

Repository-level checks: `npm run check` (import sentinel + tests + index
validation). See the repository `README.md` and `docs/DESIGN.md`.

## License

MIT (see the repository `LICENSE`). Model-facing schema and the vendored index
validator are derived from MIT-licensed DeepSeek Harness packages — see
`NOTICE`.

---

# @layman-hu/dsh-desktop-question-popup（中文）

DeepSeek Harness（DSH）的 Windows 桌面提问弹窗：当 agent 需要用户做选择时，
同一个问题会同时出现在屏幕右下角的置顶窗口里。**弹窗与 DSH 界面任一方先作答，
另一方立即结束**。

## 概述

DSH 的 `ask_user_question` 原本只在 DSH 窗口内等待。本 bundle 为它增加第二个入口：

- 问题渲染在主屏右下角的小窗口中，深色 DSH 风格，并且置顶显示；
- 窗口里显示与 DSH 卡片相同的题目、选项、自定义回答框和倒计时；
- 在弹窗里提交 → 该答案返回给模型，DSH 卡片消失；在 DSH 界面作答 → 弹窗隐藏；
- 关闭弹窗（点关闭按钮或按 Esc）**不产生答案**：DSH 继续等待，你仍可在 DSH 界面作答。

弹窗在**第一次提问时**才懒启动（常驻 helper 进程 + Edge `--app` 窗口），空闲时隐藏，
bundle 被停用/卸载时整体清理。

## 为什么需要 timed 模式（影子工具）

DSH 自带的 `ask_user_question` 位于 agent preset 内，有两种模式：

- **legacy**（阻塞）：DSH 卡片只能由用户在 DSH 界面操作才移除。因此弹窗作答后
  卡片永远关不掉。
- **timed**：请求携带 `{ callId, timed: true }`，Web Client 通过 `attachWait` 流持有
  这次等待，宿主关闭该等待才会触发卡片移除。

DSH 那一行在 preset 里，profile patch 够不到它，已挂载的 agent 也不会重建；
因此本 bundle 在每个活动 agent **自己的 tools 层**注册一个 timed 版
`ask_user_question`，用「scoped 工具覆盖继承层」的机制生效。模型面契约
（description、含 `timeout` 的 parameters、output schema、pending 提示文案）
逐字段取自 DSH 的 timed 工具，见 `NOTICE`。

停用本 bundle 后会自动恢复内置 legacy 工具，**不需要改任何配置**。

## 系统要求

- Windows 10/11（x64/arm64）；
- 已安装 Microsoft Edge（仅作为弹窗页面的渲染宿主）；
- Windows PowerShell 5.1（系统自带）或 PowerShell 7（`pwsh`）用于窗口 helper；
- DSH `>=0.2.2-rc.1 <0.3.0`（见 `engines.dsh`）。

## 安装

### 方式一：通过插件市场索引

在 DSH 的 Discover / 设置 → 插件里加入索引 URL：

```
https://raw.githubusercontent.com/layman-hu/dsh-plugins/main/index.json
```

然后从列表中安装 **Desktop question popup / 桌面提问弹窗**。

### 方式二：用 `plugin_manager` 显式安装

Git（npm 发布前的推荐方式）。把 `<commit>` 换成 `index.json` 或 release 里的
40 位十六进制 commit：

```
plugin_manager install_bundle  target=git+https://github.com/layman-hu/dsh-plugins.git#<commit>&path:/packages/dsh-desktop-question-popup
```

npm（包发布到 npm 之后）：

```
plugin_manager install_bundle  target=@layman-hu/dsh-desktop-question-popup@0.1.0
```

两种方式都会挂载本 bundle 的 `cordis.patch.yml`（只有一条 host 平面行），
**不需要**修改 preset 或 `tool-ask-user` 行。

## 配置

所有字段可选；bundle patch 使用默认值。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 设为 `false`：保留 timed 工具但不弹窗 |
| `shadowTimedTool` | `true` | 设为 `false`：不注册影子工具（仅对已是 timed 的请求弹窗） |
| `timeout` | `120` | 影子工具的默认 `timeout`（秒） |
| `width` | `460` | 窗口宽度（DIP） |
| `minHeight` / `maxHeight` | `240` / `620` | 内容高度夹取范围（DIP） |
| `margin` | `12` | 距工作区右边/下边的余量（DIP） |
| `edgePath` | 自动探测 | `msedge.exe` 路径 |
| `shellPath` | 自动探测 | helper 宿主（优先 `pwsh.exe`，否则 `powershell.exe`） |
| `userDataDir` | `%TEMP%\dsh-question-popup\edge-profile` | 专用 Edge profile |
| `logFile` | `%TEMP%\dsh-question-popup\popup.log` | 单行诊断日志 |
| `debugPort` | `0` | 非 0 时在该本机端口暴露 Chromium DevTools（仅开发用） |

## 行为与语义边界

| 场景 | 行为 |
|---|---|
| `timeout >= 1`（默认取 config） | 走 `askTimed`，**弹窗参与**，任一方先答即结束 |
| `timeout = -1`（模型要求「必须回答才能继续」） | 走内置阻塞路径，**不弹窗**：没有 `wait.timed` 时，弹窗答完 DSH 卡片收不掉 |
| 非 timed 的 `user-questions/request` | 原样交给 DSH 原生路径 |
| 弹窗不可用（非 Windows／找不到 Edge／helper 起不来／页面没就绪） | 记一次原因，之后只走原生对话框；不阻塞、不抛给工具 |
| 用户关闭弹窗 | 不产生答案；DSH 继续等待，仍可在 DSH 界面作答 |
| 弹窗未结束时又来一个问题 | 第二个走原生对话框（不叠窗口） |
| timed 等待超时 | 工具返回 `{ pending: true, callId, message }`，弹窗隐藏 |
| bundle 被停用/卸载 | 影子注册移除，自动恢复内置 legacy 工具 |

默认等待 120 秒；超时返回的是 `pending`（不是跳过）。被别的 agent 拥有的子 agent
发起提问时，DSH 本身会拒绝（`DELEGATED_CALLER`），本 bundle 不改变这条边界。

## 隐私与安全

- 页面由 `127.0.0.1` 上随机端口的本机 HTTP 服务提供，每次运行生成随机 token，
  所有提问/作答接口都校验 token。
- 弹窗运行在 **专用 Edge profile**（`%TEMP%\dsh-question-popup\edge-profile`），
  绝不动你日常浏览器的 profile、Cookie、历史记录和扩展。
- 不截屏、不读取其它窗口；除本机回环外无任何网络访问。页面不加载任何 CDN、
  外部字体或远程资源。
- 诊断日志不记录题面与答案，只有生命周期信息（题目数量、窗口矩形、状态、call id）。
- 清理时只结束「命令行包含本 bundle 专用 profile 目录」的 `msedge.exe`，绝不碰你
  自己的 Edge 窗口。

## 已知限制

- **仅 Windows**；非 Windows 主机跳过弹窗、保持原生流程。
- 依赖 Edge 与 PowerShell；缺失时弹窗降级为原生对话框。
- 影子工具依赖 DSH 的工具/agent 内部机制（`dsh-tools` 的 scoped 层、
  `user-questions` 的 timed 等待），因此用 `engines.dsh >=0.2.2-rc.1 <0.3.0`
  限定版本；超出范围的 DSH 升级可能需要更新本 bundle。
- `timeout: -1` 按设计不参与弹窗（见上表）。
- 空闲时会常驻一个 Edge 进程和一个 PowerShell helper（约 100–200 MB）以便秒开；
  退出 DSH 或停用 bundle 时释放。

## 卸载

- 在 DSH 的插件页或 `plugin_manager` 里禁用/移除本 bundle 行：清理会关闭本机
  HTTP 服务、结束 helper、停止专用 Edge 进程。
- 专用 Edge profile 与日志仍在 `%TEMP%\dsh-question-popup\`；删除该目录即可清除全部
  本地状态。

## 排障

| 现象 | 排查 |
|---|---|
| 没有弹窗，但 DSH 对话框正常 | 看 `%TEMP%\dsh-question-popup\popup.log`，找 `desktop popup unavailable, native questions only: <原因>` |
| `popup page did not become ready` | Edge 是否安装？`edgePath` 是否正确？`debugPort` 是否被别的进程占用？ |
| 弹窗出现但没置顶 | 生产环境不要设置 `debugPort`、不要额外注入 Edge 启动参数；本实现是在窗口显示**之后**单独断言置顶的 |
| 弹窗作答后 DSH 卡片还在 | 该请求不是 timed（例如 `timeout: -1`），或 `shadowTimedTool` 为 `false` |
| 窗口尺寸卡在旧值 | 页面每次渲染都会重报内容高度；若开了 `debugPort`，可看页面控制台 |

## 开发

```powershell
cd packages/dsh-desktop-question-popup
node --test            # 76 个离线用例（Node 24；不要传目录参数）
```

`tools/e2e-cdp.mjs` 通过 Chromium DevTools 驱动真实弹窗（需要 `debugPort`）：
`--action answer --label <选项>`、`--action dismiss`、`--action observe`，
输出一行 JSON（含 DOM 证据与时间戳）。

仓库级检查：`npm run check`（import 哨兵 + 测试 + index 校验）。
更多说明见仓库根 `README.md` 与 `docs/DESIGN.md`。

## 许可

MIT（见仓库 `LICENSE`）。模型面 schema 与 vendored 索引校验器取自 MIT 许可的
DeepSeek Harness 包——见 `NOTICE`。
