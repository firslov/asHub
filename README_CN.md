<p align="center"><img src="web/assets/brand/icon.svg" width="72" height="72" alt="asHub"></p>
<h1 align="center">asHub</h1>
<p align="center">让想法成形，让复杂有序</p>
<p align="center"><a href="https://ashub.aihao.world">主页与下载</a> · <a href="https://github.com/firslov/asHub/releases">Releases</a> · <a href="README.md">English</a> · <a href="README_CN.md">简体中文</a></p>

[![License](https://img.shields.io/badge/license-MIT-787868.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-22-787868.svg)](.nvmrc)
[![agent-sh](https://img.shields.io/badge/agent--sh-0.16.0-a58b5d.svg)](https://github.com/guanyilun/agent-sh/releases/tag/v0.16.0)

asHub 是基于 [agent-sh](https://github.com/guanyilun/agent-sh) 的开源桌面 AI Agent 工作台。把多会话、模型选择、子代理、终端和文件放在同一个界面，既能专注阅读结果，也能展开审阅完整执行过程。

支持 **macOS（Apple Silicon / Intel）、Windows x64 与 Linux x64**。桌面版与本地浏览器版使用同一套客户端；可使用自己的模型 API 凭据，v0.20.6 起也支持 Codex 登录；计费及订阅额度以提供商为准。

![asHub 多会话工作台：项目分析、格式化表格与会话管理](website/assets/showcase-workspace-0206-zh.jpg)

*主界面配图来自 v0.20.6 中文界面，使用隔离的演示项目与示例对话；下方详情配图来自 v0.20.2。不包含个人会话或 API 凭据。*

## 核心体验

项目协作、Codex 登录和按模型选择思考深度需使用 v0.20.6 或更新版本。

| 能力 | 使用体验 |
| --- | --- |
| 会话与项目 | 将多个对话归入项目，统一切换视图，支持搜索、置顶、归档与历史恢复 |
| 对话协作 | 在同项目对话间派发任务、跟踪回执和读取结果；可选独立 Git 工作树隔离文件改动 |
| 清晰的执行过程 | 优先展示回复与进度，思考和工具输出收纳在可展开的详情中 |
| 任务与子代理 | 任务清单与进度；规划、探索、审查、调研、实现五类子代理，支持模型与预算配置 |
| 模型与上下文 | Codex 登录、模型搜索与原生思考等级，查看上下文和实际返回的缓存用量 |
| 可审阅的操作 | 权限审批、改动预览、会话级放行；后台完成与审批通知 |
| 项目工具 | PTY 终端、文件浏览、图片输入、技能市场、用户扩展 |
| 保留工作脉络 | 会话持久化、对话分支与回退、Markdown 导出及工作目录成果下载 |
| 统一的界面 | Gruvbox 浅色与深色主题，中英文切换、显示缩放、可折叠状态栏 |
| 移动访问 · 预览 | 手机上继续已授权的桌面对话，共享历史、流式回复与单次权限审批 |

<details>
<summary>查看执行过程：任务、代码差异与工具输出</summary>

![任务进度、文件 Diff 与工具输出](website/assets/showcase-workflow.png)

</details>

<details>
<summary>查看文件侧栏</summary>

![文件侧栏与对话并排展示](website/assets/showcase-files.png)

</details>

## 安装与开始使用

从 [主页](https://ashub.aihao.world/#download) 或 [GitHub Releases](https://github.com/firslov/asHub/releases/latest) 下载。桌面安装包包含运行环境，无需单独安装 Node.js。

| 系统 | 安装包 |
| --- | --- |
| macOS Apple Silicon | `arm64.dmg` |
| macOS Intel | `x64.dmg` |
| Windows x64 | `Setup.exe` |
| Linux x64 | `.AppImage` |

1. 安装并打开 asHub
2. 在右侧配置面板设置模型提供商与默认模型；v0.20.6 起也可使用 Codex 登录
3. 新建会话，选择项目目录，开始对话；需要时打开文件、终端或其他辅助面板

### macOS 一行安装

```sh
curl -fsSL https://raw.githubusercontent.com/firslov/asHub/main/install.sh | bash
```

脚本识别 Apple Silicon / Intel，将应用安装到 `/Applications` 并清除隔离标记。手动安装 DMG 如被拦截，可在「系统设置 → 隐私与安全性」中选择「仍要打开」，或执行：

```sh
/usr/bin/xattr -dr com.apple.quarantine "/Applications/asHub.app"
```

### Windows

使用 Bash 命令与 Git 工作树前，请安装 [Git for Windows](https://git-scm.com/download/win)。asHub 会自动识别标准安装及当前用户目录下的 Git。

### Linux

下载 AppImage 后，在文件所在目录执行：

```sh
chmod +x ./asHub-*.AppImage
./asHub-*.AppImage
```

## 移动访问 · 预览

通过 [asHub 移动网页版](https://ashub.aihao.world/mobile/) 继续电脑上的对话。**需使用 asHub v0.20.5 或更新版本。**

1. 在桌面右侧工具栏打开「移动访问」，登录或注册账号，授权需要共享的项目目录
2. 保存恢复码后点击「我已保存」；未确认的恢复码在切换菜单后仍可查看，但需在退出应用或刷新前保存
3. 手机登录同一账号，选择电脑，即可继续已有对话或新建对话

电脑需保持唤醒且 asHub 正在运行。仅共享授权范围内且工作目录仍有效的对话，归档对话需先在桌面恢复。支持流式回复、图片、模型切换与单次权限审批。中转服务转发内容但不持久保存对话正文，不属于端到端加密。

移动端的项目视图、协作回执、成果下载和思考深度选择需使用桌面 v0.20.6 或更新版本，并配套更新移动网关。

## 从源码运行

项目固定使用 **Node.js 22.23.3**（最低 **22.12.0**），内核基于 **agent-sh 0.16.0**，暂时固定到包含 [Codex 流式超时修复](https://github.com/guanyilun/agent-sh/pull/281) 的 Git 提交，待上游发布后切回正式版本。使用 nvm 时：

```sh
git clone https://github.com/firslov/asHub.git
cd asHub
nvm install && nvm use
npm ci
npm run electron:dev
```

只运行本地 Web 服务：

```sh
npm start -- --port 7878
# 浏览器打开 http://localhost:7878
```

### 跨设备访问

```sh
npm start -- --host 0.0.0.0 --port 7878
```

默认仅监听 `127.0.0.1`。非回环地址需要访问令牌：启动时终端会显示自动生成的令牌，在浏览器 `/auth` 页面登录。也可通过 `ASHUB_TOKEN` 设置固定令牌；API 客户端使用 `Authorization: Bearer <令牌>`。跨设备连接请使用可信网络或 HTTPS 反向代理。

会话历史保存在本地；使用云端模型时，相关请求内容会发送给配置的提供商。ACP 会话恢复依赖后端的 `session/load`：不支持恢复或旧会话缺少远端 ID 时，历史仍可查看，但需新建会话继续。

## 工作原理

`src/hub.ts` 是核心：一个**与后端无关**的 HTTP + SSE 服务，为每个会话创建并监管一个 *bridge*。
负责对话的那一端只需发出 `BusEvent` 并实现 `submit` / `cancel` / `close` —— 接口定义见
[`src/bridges/types.ts`](src/bridges/types.ts)。

```
Electron 外壳 (electron/main.cjs)           浏览器（任意现代浏览器）
        │                                             │
        └──────────────► hub (src/hub.ts) ◄───────────┘
                     单一 HTTP 端口，路径路由 /<id>/events、/<id>/submit
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
   AshBridge               AcpBridge               TerminalBridge
   进程内 agent-sh 内核     子进程（ACP 协议）        PTY shell（node-pty）
```

| Bridge | 运行内容 | 选择方式 |
|---|---|---|
| `AshBridge` | 进程内直接跑 agent-sh 内核，无子进程，少一跳 | 默认（`--backend ash`） |
| `AcpBridge` | 说 ACP 协议的子进程，如 `agent-sh-acp`、`claude-code-acp` | `--backend acp [--cmd "CMD ARGS"]` |
| `TerminalBridge` | PTY shell 会话（agent-sh 的 shell 或普通终端） | 会话类型 `terminal` |

因此新增一种后端只需要实现一个接口，hub、SSE 协议与前端都不用改。

## 命令行参数

以下参数适用于 `ashub` / `npm start`；Electron 应用以默认值在进程内启动同一个 hub。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--backend ash\|acp` | `ash` | 桥接实现：进程内 agent-sh 内核，或 ACP 子进程 |
| `--cmd "CMD ARGS"` | `agent-sh-acp` | `--backend acp` 时启动的子进程命令（支持双引号） |
| `--port N` | `7878` | HTTP 端口 |
| `--host HOST` | `127.0.0.1` | 绑定地址 |
| `--web PATH` | `./web` | 静态资源根目录 |
| `--model NAME` | 配置默认值 | 覆盖模型（ash 后端） |
| `--provider NAME` | 配置默认值 | 覆盖 Provider（ash 后端） |
| `-h`, `--help` | — | 显示帮助 |

```sh
# 进程内内核（默认）
ashub --port 8080

# 改为拉起 Claude Code 的 ACP 服务
ashub --backend acp --cmd "claude-code-acp"
```

## 项目结构

```text
src/                  HTTP/SSE 服务、会话生命周期、历史与权限
  bridges/            agent-sh / ACP / PTY 桥接实现
  history/            历史存储、帧捕获与上下文压缩
web/                  原生 ES 模块与 CSS，无前端构建步骤
  js/stream/          思考、工具、任务、正文与实时输出渲染
  assets/brand/       统一的图标、标志与矢量字标
electron/             桌面窗口、IPC、自动更新与应用图标
website/              主页、下载模板、字体与应用配图
scripts/              构建辅助与演示配图截取
tests/                隔离回归、HTTP 与内核兼容测试
examples/extensions/  扩展示例
```

## 开发与验证

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 编译后端 TypeScript 至 `dist/` |
| `npm run typecheck` | 后端类型检查 |
| `npm run typecheck:web` | 前端工程检查 |
| `npm test` | 隔离回归测试 |
| `npm run test:http` | HTTP 与会话接口测试 |
| `npm run test:kernel` | 构建并检查内核及 Codex 兼容性 |
| `npm run test:network` | 代理与网络行为测试 |
| `npm run test:worktrees` | 独立 Git 工作树测试 |
| `npm run electron:pack` | 生成解包应用 |
| `npm run electron:dist:mac` | 构建 macOS 安装包 |
| `npm run electron:dist:win` | 构建 Windows 安装包 |

Electron 加载编译后的 `dist/`，CLI 通过 `tsx` 运行源码。前端第三方库随仓库提供，界面资源无需外部 CDN。回归测试使用临时数据与模拟边界，不调用模型，也不读取实际配置密钥。

技能可从内置市场安装；扩展从 `~/.agent-sh/extensions/` 加载，支持 TypeScript。参见 [扩展示例](examples/extensions/wechat-bot)。HTTP 路由实现参见 [`src/hub.ts`](src/hub.ts)，后端接入契约参见 [`src/bridges/types.ts`](src/bridges/types.ts)。

## 许可证

[MIT](LICENSE)
