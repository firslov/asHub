# asHub

[English](#ashub) | [简体中文](#ashub-中文)

Desktop app for [agent-sh](https://github.com/guanyilun/agent-sh) — runs agent-sh sessions and exposes them through a browser UI.

![asHub demo](docs/demo.gif)

## Features

- **Multi-session** — sidebar to spawn, switch, and close sessions
- **Session persistence** — conversations survive restarts
- **Live streaming** — SSE with Markdown, syntax-highlighted code, diff views, and tool calls
- **Reasoning compaction** — consecutive think→tool rounds auto-collapse into a single expandable block
- **Desktop native** — packaged for macOS (Apple Silicon) and Windows (x64)

## Install

Download from [GitHub Releases](https://github.com/firslov/ashub/releases).

> **macOS:** `xattr -dr com.apple.quarantine "/Applications/asHub.app"`
>
> **Windows:** Requires PowerShell 5.1 or later (built into Windows 10/11).

## Dev

```sh
npm install
npm run electron:dev        # dev mode
npm run electron:dist:mac   # build macOS .dmg
npm run electron:dist:win   # build Windows .exe
```

## CLI

```sh
ashub                        # default: port 7878
ashub --port 8080
ashub --model gpt-4o
```

| Flag            | Default          | Description             |
|-----------------|------------------|-------------------------|
| `--port N`      | `7878`           | HTTP port               |
| `--host HOST`   | `127.0.0.1`      | Bind host               |
| `--model NAME`  | settings default | Model override          |
| `--provider NAME` | settings default | Provider override     |

## Status

Beta. Localhost only by default.

---

# asHub (中文)

[English](#ashub) | [简体中文](#ashub-中文)

[agent-sh](https://github.com/guanyilun/agent-sh) 的桌面应用 —— 运行 agent-sh 会话并通过浏览器界面进行交互。

![asHub 演示](docs/demo.gif)

## 功能特性

- **多会话** —— 侧边栏可创建、切换、关闭会话
- **会话持久化** —— 重启后对话依然保留
- **实时流式输出** —— 基于 SSE,支持 Markdown、语法高亮代码、Diff 视图和工具调用
- **推理过程折叠** —— 连续的 think→tool 轮次自动折叠为可展开的单一块
- **桌面原生** —— 已打包支持 macOS(Apple Silicon)和 Windows(x64)

## 安装

从 [GitHub Releases](https://github.com/firslov/ashub/releases) 下载。

> **macOS:** `xattr -dr com.apple.quarantine "/Applications/asHub.app"`
>
> **Windows:** 需要 PowerShell 5.1 或更高版本(Windows 10/11 自带)。

## 开发

```sh
npm install
npm run electron:dev        # 开发模式
npm run electron:dist:mac   # 构建 macOS .dmg
npm run electron:dist:win   # 构建 Windows .exe
```

## 命令行

```sh
ashub                        # 默认端口 7878
ashub --port 8080
ashub --model gpt-4o
```

| 参数              | 默认值           | 说明              |
|-------------------|------------------|-------------------|
| `--port N`        | `7878`           | HTTP 端口         |
| `--host HOST`     | `127.0.0.1`      | 绑定地址          |
| `--model NAME`    | 配置默认值       | 覆盖模型          |
| `--provider NAME` | 配置默认值       | 覆盖 Provider     |

## 状态

Beta 阶段。默认仅监听本地。
