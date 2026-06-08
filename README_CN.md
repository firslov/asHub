# asHub

[English](README.md) | [简体中文](#ashub-中文)

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

[agent-sh](https://github.com/guanyilun/agent-sh) 的桌面应用 —— 运行 agent-sh 会话并通过浏览器界面进行交互。

![asHub demo](docs/index.png)

## 功能特性

- **多会话** —— 侧边栏可创建、切换、关闭会话
- **会话持久化** —— 重启后对话依然保留
- **自动标题** —— LLM 生成会话标题，纯文本回退兜底
- **实时流式输出** —— SSE 支持 Markdown、语法高亮代码、Diff 视图和工具调用
- **推理过程折叠** —— 连续的 think→tool 轮次自动折叠为可展开的单一块
- **图片支持** —— 多模态模型支持粘贴/上传图片，自动压缩并使用 Blob URL 渲染
- **模型选择器** —— 按 provider 分组、可搜索的下拉列表，实时同步 OpenRouter 目录（300+ 模型）
- **多模态指示器** —— 输入框左侧图标标识当前模型是否支持图片
- **状态栏折叠** —— 一键隐藏/显示模型、缓存、余额信息
- **缓存命中率** —— 圆形进度环展示 prompt cache 命中效率
- **Provider 余额** —— 按会话独立显示 DeepSeek、OpenRouter 余额
- **热重载** —— apiKey 和 provider 配置修改后立即生效，无需重启
- **流式性能优化** —— block 级增量渲染、防抖语法高亮、SPA DOM 缓存
- **休眠保护** —— 系统休眠时自动暂停 SSE，唤醒后无缝恢复
- **跨平台** —— 已打包支持 macOS (Apple Silicon)、Windows (x64) 和 Linux (AppImage)

## 安装

### macOS (Apple Silicon)

一行命令安装，无需处理 Gatekeeper 拦截：

```sh
curl -fsSL https://raw.githubusercontent.com/firslov/ashub/main/install.sh | bash
```

安装到 `/Applications` 并清除隔离标记。

<details>
<summary>想用 .dmg 安装？</summary>

从 [Releases](https://github.com/firslov/ashub/releases) 下载，拖入 Applications，然后：

- 执行 `/usr/bin/xattr -dr com.apple.quarantine "/Applications/asHub.app"`，**或**
- 先打开一次，进入 **系统设置 → 隐私与安全性**，拉到底部点击 **仍要打开**。

</details>

### Windows

从 [Releases](https://github.com/firslov/ashub/releases) 下载安装包。需要 PowerShell 5.1+（Windows 10/11 自带）。

### Linux

从 [Releases](https://github.com/firslov/ashub/releases) 下载 AppImage。

### 源码运行

需要 **Node.js ≥ 20**。

```sh
git clone https://github.com/firslov/ashub.git
cd ashub
npm install
```

**Electron**（桌面应用）：

```sh
npm run electron:dev
```

**命令行**（无窗口服务器）：

```sh
npm start -- --port 8080
```

**浏览器**（用任意浏览器作为界面）：

```sh
npm start -- --host 0.0.0.0 --port 7878
# 在浏览器中打开 http://localhost:7878
```

> 绑定 `0.0.0.0` 允许局域网内其他设备访问。
> `127.0.0.1`（默认）仅限本机访问。

**构建**可分发的安装包：

```sh
npm run electron:dist:mac   # macOS .dmg
npm run electron:dist:win   # Windows .exe
```

#### 命令行参数

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--port N` | `7878` | HTTP 端口 |
| `--host HOST` | `127.0.0.1` | 绑定地址 |
| `--model NAME` | 配置默认值 | 覆盖模型 |
| `--provider NAME` | 配置默认值 | 覆盖 Provider |

## 许可证

MIT
