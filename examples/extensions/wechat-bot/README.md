# wechat-bot

给 agent 增加微信消息发送能力，基于 [wechat-ilink-bot](https://wechat-ilink-bot.readthedocs.io/) 的 Webhook 接口。

## 工作原理

```
agent-sh (this extension)
    │  registerTool("send_wechat_message")
    ▼
wechat-ilink-bot webhook  (127.0.0.1:8787)
    │  HTTP POST /send
    ▼
WeChat iLink Bot API
```

插件注册一个 `send_wechat_message` 工具，agent 在用户要求「发微信 / 提醒 / 通知」时调用它，通过 HTTP 转发给本地运行的 wechat-ilink-bot webhook 服务。

## 前置条件（Python 侧）

```bash
pip install "wechat-ilink-bot[webhook]"

# 首次登录（扫码，账号状态持久化）
wechat-bot login

# 启动 webhook 服务
wechat-bot webhook --api-key your-secret --host 127.0.0.1 --port 8787
```

> `--host 0.0.0.0` 可让其他机器访问；插件默认连 `127.0.0.1:8787`。

## 安装插件

```bash
# 方式一：agent-sh 安装命令（会运行 npm install）
agent-sh install ./examples/extensions/wechat-bot

# 方式二：手动复制
cp -r examples/extensions/wechat-bot ~/.agent-sh/extensions/
cd ~/.agent-sh/extensions/wechat-bot && npm install
```

## 配置

在 `~/.agent-sh/settings.json` 中：

```json
{
  "wechat-bot": {
    "baseUrl": "http://127.0.0.1:8787",
    "apiKey": "your-secret",
    "defaultTo": ""
  }
}
```

| 字段 | 说明 |
|---|---|
| `baseUrl` | webhook 服务地址（默认 `http://127.0.0.1:8787`） |
| `apiKey` | 启动 webhook 时设置的 `--api-key` |
| `defaultTo` | 默认接收人（如 `o9xxx@im.wechat`），留空则发给 bot 拥有者（owner） |

## 使用示例

对 agent 说：

- 「给张三发一条微信：会议改到下午三点」
- 「提醒我微信上的老板：报告已提交」

agent 会调用 `send_wechat_message`，参数：

```json
{ "text": "会议改到下午三点", "to": "o9xxx@im.wechat" }
```

不传 `to` 时发给 `defaultTo`（或 owner）。

## 限制

- 当前仅支持**文本**消息。wechat-ilink-bot 的图片/视频/文件发送走 Python SDK 的 `Bot.send_image` 等，未接入 webhook；如需可在本插件的 `execute` 里改为调用本地 Python 脚本。
- 需要 webhook 服务保持运行；插件会在连接失败/超时（10s）时返回明确的错误和启动提示。

## 安全提示

- `apiKey` 会随请求发送，请勿把 webhook 暴露到公网。
- 发送是**有外部副作用**的操作，agent 发送前会先确认内容与接收人。
