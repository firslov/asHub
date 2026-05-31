# asHub

[English](README.md) | [简体中文](#ashub-中文)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

[agent-sh](https://github.com/guanyilun/agent-sh) 的桌面应用 —— 运行 agent-sh 会话并通过浏览器界面进行交互。

![asHub demo](docs/demo.png)

## 功能特性

- **多会话** —— 侧边栏可创建、切换、关闭会话
- **会话持久化** —— 重启后对话依然保留
- **实时流式输出** —— SSE 支持 Markdown、语法高亮代码、Diff 视图和工具调用
- **推理过程折叠** —— 连续的 think→tool 轮次自动折叠为可展开的单一块
- **图片支持** —— 多模态模型（GPT-4o、Claude、Gemini、GLM）支持粘贴/上传图片
- **模型选择器** —— 按 provider 分组、可搜索的下拉列表，展示全部已配置模型
- **缓存命中率** —— 圆形进度环展示 prompt cache 命中效率
- **DeepSeek 余额** —— 按会话独立显示 DeepSeek provider 余额
- **跨平台** —— 已打包支持 macOS (Apple Silicon)、Windows (x64) 和 Linux (AppImage)

## 安装

**macOS (Apple Silicon)** —— 一行命令安装，无需处理 Gatekeeper 拦截：

```sh
curl -fsSL https://raw.githubusercontent.com/firslov/ashub/main/install.sh | bash
```

脚本会下载最新版本、安装到 `/Applications` 并清除隔离标记。asHub 使用 ad-hoc
签名但未经过公证（没有付费的 Apple Developer 账号），因此直接从浏览器下载会被
Gatekeeper 拦截。

<details>
<summary>想用 .dmg 安装？</summary>

从 [Releases](https://github.com/firslov/ashub/releases) 下载，把 asHub 拖入
Applications，然后任选其一：

- 执行 `/usr/bin/xattr -dr com.apple.quarantine "/Applications/asHub.app"`，**或**
- 先打开一次，再进入 **系统设置 → 隐私与安全性**，拉到底部点击 **仍要打开**。
  （macOS Sequoia 及更高版本已移除右键 → 打开的旧方式。）

</details>

**Windows** —— 从 [Releases](https://github.com/firslov/ashub/releases) 下载
安装包。需要 PowerShell 5.1 或更高版本（Windows 10/11 自带）。

**Linux** —— 从 [Releases](https://github.com/firslov/ashub/releases) 下载
AppImage。

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

## 许可证

MIT
