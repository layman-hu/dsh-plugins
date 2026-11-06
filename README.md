# layman-hu/dsh-plugins

Plugin monorepo for **DeepSeek Harness (DSH)**: a format-1 plugin market index
plus npm-installable bundles. First bundle: a Windows desktop question popup that
mirrors `ask_user_question` in a bottom-right always-on-top window.

<!-- EN -->

## Overview

This repository is both a **market index** and the **packages** it lists:

- `index.json` — format-1 plugin market index. Add its index URL to DSH
  (Discover / Settings → plugins) and the bundles below become installable.
- `packages/*` — one directory per DSH bundle. Each exports a
  `cordis.patch.yml` layer that `plugin_manager install_bundle` mounts.
- `scripts/` — index generation, index validation, and an import sentinel.
- `docs/DESIGN.md` — how the first bundle works and which DSH internals it uses.

Bundles in this repository:

| Package | What it does | Platform |
|---|---|---|
| [`@layman-hu/dsh-desktop-question-popup`](packages/dsh-desktop-question-popup/README.md) | mirrors DSH `ask_user_question` in a bottom-right always-on-top window; answering on either side ends the other | Windows |

## Why timed (the shadowed tool)

DSH's `ask_user_question` row lives inside an agent preset, which a profile patch
cannot reach, and an already-mounted agent is not rebuilt when that preset
changes. The shipped default is also **legacy blocking**: the DSH question card
can only be removed by acting in the DSH UI, so a popup answer could never close
it.

`dsh-desktop-question-popup` therefore registers its own **timed**
`ask_user_question` into each live agent's tools layer (scoped tools shadow the
inherited preset row). The model-facing contract is copied field by field from
DSH's timed tool; a popup answer settles the timed wait, and the client removes
the card. Disabling the bundle restores the shipped tool — nothing to revert.

See `docs/DESIGN.md` for the race, the client claim chain, and the exact upstream
files it depends on.

## Requirements

- DSH `>=0.2.2-rc.1 <0.3.0` (see `engines.dsh`).
- Node.js `^22.19.0 || >=24.0.0` for development and CI (the packages themselves
  run inside DSH and declare no dependencies).
- For the desktop popup bundle: Windows 10/11, Microsoft Edge, and Windows
  PowerShell 5.1 or PowerShell 7.

## Install

### 1. Through the plugin market index

Add this index URL in DSH (Discover / Settings → plugins), then install the
bundle from the list:

```
https://raw.githubusercontent.com/layman-hu/dsh-plugins/main/index.json
```

### 2. Explicitly through `plugin_manager`

Git (recommended until the packages are published on npm). Replace `<commit>`
with the 40-hex commit recorded in `index.json` or in a release tag:

```
plugin_manager install_bundle  target=git+https://github.com/layman-hu/dsh-plugins.git#<commit>&path:/packages/dsh-desktop-question-popup
```

npm (after publishing):

```
plugin_manager install_bundle  target=@layman-hu/dsh-desktop-question-popup@0.1.0
```

Both paths mount the package's `cordis.patch.yml`; no agent preset or
`tool-ask-user` row is edited.

> **What the index pins:** `index.json` pins the commit that produced the
> released package, not `HEAD`. After the repository was first pushed, run
> `node scripts/make-index.mjs` and commit the refreshed `index.json`. Any later
> change to a package manifest (including an npm-scope rename) needs the same two
> steps: commit the change, regenerate the index, commit the index again —
> `npm run index:check` verifies that pair and the pinned commit's contents.

## Configuration

Configuration is per bundle (shown here for the desktop popup; each package
README documents its own table). All fields are optional.

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` keeps the timed tool but never shows the popup |
| `shadowTimedTool` | `true` | `false` skips the shadowed tool (popup only for already-timed requests) |
| `timeout` | `120` | default `timeout` in seconds for the shadowed tool |
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
| `timeout >= 1` (config default `120`) | timed wait; the popup participates; first answer wins |
| `timeout = -1` | shipped blocking path, **no popup**: without `wait.timed` the DSH card cannot be removed after a popup answer |
| non-timed `user-questions/request` | passed through unchanged |
| popup unavailable (not Windows, no Edge, helper failure, page not ready) | logged once; the native dialog is used; never blocks, never throws |
| user closes the popup | no answer is produced; DSH keeps waiting and stays answerable |
| second question while a popup is open | the second uses the native dialog (no stacked windows) |
| timed wait expires | tool returns `{ pending: true, callId, message }`; popup hides |
| bundle disabled/uninstalled | shadowed registration removed; the shipped legacy tool returns |

## Privacy and security

- The popup page is served by a loopback HTTP server on `127.0.0.1` with a random
  port and a random per-run token; question and answer routes require the token.
- The popup uses a **dedicated Edge profile** under `%TEMP%`; your everyday
  browser profile, cookies, history, and extensions are untouched.
- No screen capture, no reading other windows, no network beyond loopback, no CDN
  or remote assets in the UI.
- Diagnostics never record question text or answers — lifecycle lines only.
- Cleanup kills only `msedge.exe` processes whose command line contains the
  bundle's dedicated profile directory.

## Known limitations

- The desktop popup is **Windows only**; other hosts keep the native dialog.
- Requires Edge and PowerShell; missing prerequisites degrade to native.
- The shadowed tool depends on DSH internals (`dsh-tools` scoped layers,
  `user-questions` timed waits), so it is pinned by `engines.dsh`; a DSH upgrade
  outside that range may need a bundle update.
- Requests from delegated child agents are rejected by DSH itself
  (`DELEGATED_CALLER`); bundles do not change that boundary.

## Uninstall

- Disable or remove the bundle row in DSH (Plugins page or `plugin_manager`).
  Cleanup closes the loopback server, stops the helper, and ends the dedicated
  Edge process.
- Local state stays under `%TEMP%\dsh-question-popup\`; delete that directory to
  remove it.
- To stop reading the market index, remove its URL from DSH settings.

## Troubleshooting

| Symptom | Check |
|---|---|
| Bundle listed but nothing happens | The profile must match (`plugin_manager` reports the live profile dir); check DSH logs |
| Popup never appears, dialog works | `%TEMP%\dsh-question-popup\popup.log` — `desktop popup unavailable, native questions only: <reason>` |
| Popup shows, not on top | Do not set `debugPort` in production and do not inject extra Edge flags; topmost is asserted after the window is shown |
| Popup answer leaves the DSH card | The request was not timed (e.g. `timeout: -1`) or `shadowTimedTool` is `false` |
| `index.json` rejected by DSH | `npm run validate` — it runs the vendored format-1 validator used by the market |

## Repository layout

```
.                     LICENSE, NOTICE, CHANGELOG, AGENTS.md, CI, index.json
scripts/              make-index, validate-index, sentinel, vendored validator
docs/DESIGN.md        mechanism + upstream source references
packages/<name>/      publishable DSH bundle (lib/, ui/, locale/, tests/, tools/)
```

## Development

```powershell
npm run sentinel        # import sentinel for every package host half
npm test                # all tests (node --test at the root, fixtures included)
npm run validate        # validate index.json with the vendored validator
npm run index           # regenerate index.json from git HEAD
npm run index:check     # index matches manifests + pinned commits contain versions
npm run check           # sentinel + tests + validate + index:check
```

`npm run index:check` is the CI gate: it compares the committed index with the
current package manifests (ignoring each version's pinned commit) and verifies
that every pinned commit really contains the indexed package version. It does
**not** compare against HEAD, so it still passes after you commit `index.json`
(HEAD then points at the index commit while the index keeps pinning the release
commit). `node scripts/index-check.test.mjs` exercises that behaviour offline.

Node 24 discovers `**/*.test.mjs`; do not pass a directory to `node --test`.

## Adding a plugin package

1. Create `packages/<name>/` with `package.json`, `cordis.patch.yml`, `lib/`,
   `tests/`, and a bilingual `README.md`.
2. Declare `dsh.bundle` (`patch`, `platforms`) and `dsh.market`
   (`category`, `labels`, `title`, `description`). Referenced category/label ids
   must be declared in the root `package.json` `dsh.marketIndex`.
3. `npm run sentinel && npm test && npm run index && npm run validate`.
4. Follow the sanitization rules in `AGENTS.md` (no absolute paths, user names,
   session ids, or private artifacts).

## Release

See `AGENTS.md` §8. In short: bump version → add a `CHANGELOG.md` entry →
`npm run check` → commit → `npm run index` and commit `index.json` (pinned to the
release commit) → `npm run index:check` must pass → push. Optional npm publish,
then regenerate the index with `--npm`.

## License and attribution

MIT — see `LICENSE`. The model-facing `ask_user_question` schema and the vendored
format-1 index validator are derived from MIT-licensed DeepSeek Harness packages;
their notices are reproduced in `NOTICE`.

---

# layman-hu/dsh-plugins（中文）

**DeepSeek Harness（DSH）** 的插件 monorepo：包含 format-1 插件市场索引，以及可
通过 npm 安装的 bundle。首个 bundle 是 Windows 桌面提问弹窗——把
`ask_user_question` 同步显示在屏幕右下角的置顶窗口里。

## 概述

本仓库同时是**市场索引**和它列出的**插件包**：

- `index.json` —— format-1 插件市场索引。把它的索引 URL 加进 DSH
  （Discover / 设置 → 插件），下面这些 bundle 即可安装；
- `packages/*` —— 一个目录一个 DSH bundle，各自导出 `cordis.patch.yml`，
  由 `plugin_manager install_bundle` 挂载；
- `scripts/` —— 索引生成、索引校验、import 哨兵；
- `docs/DESIGN.md` —— 首个 bundle 的机制与所依赖的 DSH 内部实现。

本仓库包含的 bundle：

| 包 | 作用 | 平台 |
|---|---|---|
| [`@layman-hu/dsh-desktop-question-popup`](packages/dsh-desktop-question-popup/README.md) | 在屏幕右下角置顶窗口同步显示 DSH 的 `ask_user_question`；任一方作答，另一方立即结束 | Windows |

## 为什么需要 timed（影子工具）

DSH 的 `ask_user_question` 这一行位于 agent preset 内：profile patch 够不到它，
而且 preset 变化时已挂载的 agent 不会重建。DSH 默认还是 **legacy 阻塞模式**：
DSH 的提问卡片只能由用户在 DSH 界面操作移除，因此弹窗作答永远关不掉卡片。

`dsh-desktop-question-popup` 因此在每个活动 agent 的 tools 层注册自己的
**timed** `ask_user_question`（scoped 工具覆盖继承层）。它的模型面契约逐字段取自
DSH 的 timed 工具；弹窗作答会结束这次 timed 等待，客户端随即移除卡片。停用
bundle 即恢复内置工具，无需回滚任何配置。

竞速、客户端 claim 链路以及所依赖的上游文件见 `docs/DESIGN.md`。

## 系统要求

- DSH `>=0.2.2-rc.1 <0.3.0`（见 `engines.dsh`）；
- 开发与 CI 需要 Node.js `^22.19.0 || >=24.0.0`（插件本身运行在 DSH 内，不声明依赖）；
- 桌面弹窗 bundle 需要：Windows 10/11、Microsoft Edge、Windows PowerShell 5.1 或
  PowerShell 7。

## 安装

### 方式一：通过插件市场索引

在 DSH 的 Discover / 设置 → 插件里加入这个索引 URL，然后从列表中安装：

```
https://raw.githubusercontent.com/layman-hu/dsh-plugins/main/index.json
```

### 方式二：用 `plugin_manager` 显式安装

Git（npm 发布前的推荐方式）。把 `<commit>` 换成 `index.json` 或 release tag 里的
40 位十六进制 commit：

```
plugin_manager install_bundle  target=git+https://github.com/layman-hu/dsh-plugins.git#<commit>&path:/packages/dsh-desktop-question-popup
```

npm（发布之后）：

```
plugin_manager install_bundle  target=@layman-hu/dsh-desktop-question-popup@0.1.0
```

两种方式都会挂载该包的 `cordis.patch.yml`，**不会**修改 agent preset 或
`tool-ask-user` 行。

> **索引钉的是发布 commit**：`index.json` 固定指向产生该版本包的 commit，而不是
> `HEAD`。仓库首次 push 之后，请运行 `node scripts/make-index.mjs` 并把刷新后的
> `index.json` 一并提交。此后任何包清单变更（包括这次 npm scope 改名）都走同样两步：
> 先提交变更，再重新生成索引并提交索引——`npm run index:check` 会校验两者的对应关系
> 以及 pinned commit 里的包内容。

## 配置

配置按 bundle 划分（这里列出桌面弹窗的字段；各包 README 有自己的表）。所有字段可选。

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
| `timeout >= 1`（默认 120） | 走 timed 等待，弹窗参与，任一方先答即结束 |
| `timeout = -1` | 走内置阻塞路径，**不弹窗**：没有 `wait.timed` 时，弹窗答完 DSH 卡片收不掉 |
| 非 timed 的 `user-questions/request` | 原样交给 DSH 原生路径 |
| 弹窗不可用（非 Windows／找不到 Edge／helper 起不来／页面没就绪） | 记一次原因，改走原生对话框；不阻塞、不抛错 |
| 用户关闭弹窗 | 不产生答案；DSH 继续等待，仍可作答 |
| 弹窗未结束时又来一个问题 | 第二个走原生对话框（不叠窗口） |
| timed 等待超时 | 工具返回 `{ pending: true, callId, message }`，弹窗隐藏 |
| bundle 停用/卸载 | 影子注册移除，恢复内置 legacy 工具 |

## 隐私与安全

- 弹窗页面由 `127.0.0.1` 上随机端口的本机 HTTP 服务提供，每次运行生成随机 token，
  提问/作答接口都校验 token；
- 弹窗使用 `%TEMP%` 下的**专用 Edge profile**，不动日常浏览器的 profile、Cookie、
  历史与扩展；
- 不截屏、不读取其它窗口、除本机回环外无网络访问；UI 不加载任何 CDN 或远程资源；
- 诊断日志不记录题面与答案，只记生命周期信息；
- 清理时只结束命令行包含本 bundle 专用 profile 目录的 `msedge.exe`。

## 已知限制

- 桌面弹窗**仅 Windows**；其它平台保持原生对话框；
- 依赖 Edge 与 PowerShell；缺失时降级为原生；
- 影子工具依赖 DSH 内部机制（`dsh-tools` 的 scoped 层、`user-questions` 的 timed
  等待），因此用 `engines.dsh` 限定版本；超出范围的 DSH 升级可能需要更新 bundle；
- 被别的 agent 拥有的子 agent 发起提问时，DSH 本身会以 `DELEGATED_CALLER` 拒绝，
  bundle 不改变这条边界。

## 卸载

- 在 DSH 插件页或 `plugin_manager` 里禁用/移除 bundle 行：清理会关闭本机 HTTP 服务、
  结束 helper、停止专用 Edge 进程；
- 本地状态留在 `%TEMP%\dsh-question-popup\`，删除该目录即可清除；
- 不想再看到市场索引，就在 DSH 设置里移除它的 URL。

## 排障

| 现象 | 排查 |
|---|---|
| 列表里有但没反应 | 确认 profile 与宿主一致（`plugin_manager` 会报当前 profile 目录）；查 DSH 日志 |
| 弹窗从不出现，对话框正常 | 看 `%TEMP%\dsh-question-popup\popup.log` 的 `desktop popup unavailable, native questions only: <原因>` |
| 弹窗出现但不置顶 | 生产环境不要设置 `debugPort`、不要额外注入 Edge 参数；置顶是在窗口显示后单独断言的 |
| 弹窗作答后 DSH 卡片还在 | 该请求不是 timed（例如 `timeout: -1`）或 `shadowTimedTool` 为 `false` |
| `index.json` 被 DSH 拒绝 | `npm run validate`，它跑的是市场使用的同一份 vendored format-1 校验器 |

## 仓库结构

```
.                     LICENSE、NOTICE、CHANGELOG、AGENTS.md、CI、index.json
scripts/              make-index、validate-index、sentinel、vendored 校验器
docs/DESIGN.md        机制与上游源码依据
packages/<name>/      可发布的 DSH bundle（lib/、ui/、locale/、tests/、tools/）
```

## 开发

```powershell
npm run sentinel        # 对每个包的 host 半做 import 哨兵
npm test                # 全部测试（根目录 node --test，含离线 fixture）
npm run validate        # 用 vendored 校验器校验 index.json
npm run index           # 从 git HEAD 重新生成 index.json
npm run index:check     # 索引与包清单一致 + 每个 pinned commit 含对应版本
npm run check           # 哨兵 + 测试 + 索引校验 + index:check
```

`npm run index:check` 是 CI 门禁：它把已提交索引与当前包清单比较（**忽略** 每个版本的
pinned commit），并校验每个 pinned commit 里确实含有索引声明的包版本。它**不与 HEAD
比较**，因此提交 `index.json` 之后（HEAD 变成索引提交、索引仍钉发布提交）依然通过。
`node scripts/index-check.test.mjs` 用临时 git 仓库离线覆盖该行为。

Node 24 会递归发现 `**/*.test.mjs`；不要把目录参数传给 `node --test`。

## 新增插件包

1. 新建 `packages/<name>/`，包含 `package.json`、`cordis.patch.yml`、`lib/`、
   `tests/` 和双语 `README.md`；
2. 在 `package.json` 里声明 `dsh.bundle`（`patch`、`platforms`）与 `dsh.market`
   （`category`、`labels`、`title`、`description`）；引用的 category/label id 必须在
   根 `package.json` 的 `dsh.marketIndex` 中声明；
3. 运行 `npm run sentinel && npm test && npm run index && npm run validate`；
4. 遵守 `AGENTS.md` 的脱敏规则（不得出现绝对路径、用户名、session id、私有产物）。

## 发布

见 `AGENTS.md` §8。简言之：升版本 → 补 `CHANGELOG.md` → `npm run check` → 提交 →
`npm run index` 并把 `index.json` 一并提交（钉在**发布提交**上）→ `npm run index:check`
必须通过 → push。可选的 npm 发布路径：发布后用 `--npm` 重新生成索引。

## 许可与归属

MIT，见 `LICENSE`。模型面 `ask_user_question` schema 与 vendored format-1 索引
校验器取自 MIT 许可的 DeepSeek Harness 包，其声明见 `NOTICE`。
