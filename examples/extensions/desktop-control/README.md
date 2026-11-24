# asHub Desktop Control

asHub 的可选 macOS 桌面控制插件，也可通过独立安装包分发。

使用当前对话的模型规划操作，由固定版本的 arc-driver 执行。支持应用与窗口发现、辅助功能控件、截图和坐标操作。仅支持 macOS；截图需要支持图片输入的模型。

## 安装

桌面控制仅随新版 asHub 的 macOS 版提供，默认关闭。先在「插件 → 本地扩展」启用，再打开新对话运行安装命令。

```text
/desktop install
```

需要 macOS 14+（Apple Silicon 或 Intel）和本机 Python 3.12+。上述命令检查并准备驱动。已有手动安装的插件优先使用，并保留其设置。

### 使用独立安装包

也可在「插件 → 安装插件」导入 ZIP。若从解压目录手动安装，请用 Node.js 22.12+ 执行安装脚本。

```sh
node scripts/install.mjs
```

手动脚本默认安装到 `~/.agent-sh/extensions/ashub-desktop-control/`。设置了 `AGENT_SH_HOME` 时使用该目录，也可传 `--home /path/to/agent-home`。脚本仅安装本插件文件，不会覆盖同名未知目录。手动安装完成后，完全退出并重启 asHub（包括状态栏后台进程），启用插件后用 `/desktop install` 检查驱动。

驱动按固定提交下载到 `~/.agent-sh/desktop-control/runtimes/`。导入 ZIP 时，asHub 会在安装预览中检查 macOS 14+、CPU 架构和 Python 3.12+，并将解析后的绝对路径通过 `ASHUB_RUNTIME_PYTHON` 传给 setup。也可在启动 asHub 前显式设置 `ASHUB_RUNTIME_PYTHON`，原有的 `ASHUB_DESKTOP_PYTHON` 继续兼容。`/desktop status` 会验证 Python 能否导入 arc_cua、Cocoa、Quartz、ApplicationServices 和 Vision。已有环境损坏时，`/desktop install` 和 ZIP 安装都可以重建环境，健康检查通过后才替换旧环境。

## 授权与使用

1. 在 macOS **系统设置 → 隐私与安全性** 中给实际启动程序授予 **辅助功能** 权限；截图还需要 **屏幕录制** 权限。开发启动可能显示 Electron 或终端。
2. 重启 asHub，打开要操作的应用，在对话中执行 `/desktop apps` 查看应用标识和权限状态。
3. 运行 `/desktop allow com.apple.TextEdit` 设置允许的应用（此命令替换整个列表；多个 ID 用空格分隔），再运行 `/desktop enable`。
4. 对模型说：“在文本编辑中新建一份会议提纲，先不要保存”，并审批桌面任务。

也可在现有 **插件 → ashub-desktop-control → 配置** 中编辑 `desktop-control` 命名空间。首次加载插件的对话建立后会自动发现该命名空间。示例：

```json
{
  "enabled": true,
  "allowedApps": ["com.apple.TextEdit"]
}
```

默认关闭且无允许应用。范围配置保存后插件会检测变更、取消旧任务，通常在 250 ms 左右生效；操作前也会核对允许范围。通过 `/desktop` 修改范围会立即取消旧任务。已有集成预览的 `desktop-control` 配置与驱动目录可以继续使用。

插件保留 asHub 原有审批策略。如果关闭了主程序的自动审批，主程序还可能对每次有副作用的工具调用显示通用审批；插件不会绕过这些审批。`desktop_start` 另行申请指定应用和窗口的桌面授权。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/desktop status` | 查看配置、组件安装和任务状态 |
| `/desktop apps` | 检查系统权限，列出运行应用 |
| `/desktop allow <Bundle IDs>` | 替换允许应用列表 |
| `/desktop allow none` | 清空允许应用列表 |
| `/desktop enable` / `/desktop disable` | 启用或关闭桌面控制 |
| `/desktop stop` | 取消全部任务，包括待审批和排队任务 |
| `/desktop install` | 检查、安装或修复固定版本的驱动 |

驱动安装与权限诊断使用命令，配置使用 asHub 现有插件菜单；不额外注入网页、菜单或 HTTP 接口。

## 生命周期与边界

- 同一 asHub 进程内的会话共用驱动，按完整任务排队；单任务 5 分钟、排队最多 10 分钟。
- 工具顺序执行，快照和截图归属当前窗口。坐标操作按截图像素换算窗口坐标。
- 桌面工具不交给子代理；通过扩展钩子隔离子代理执行上下文，不修改主程序。
- 对话结束、取消、关闭时释放窗口。最后一个加载此插件的会话关闭时，插件关闭驱动和安装子进程。
- 停用插件沿用 asHub 的加载规则：对新内核生效，重启后全部生效。需要立即停止时先执行 `/desktop disable` 或 `/desktop stop`。
- 截图和窗口文本会进入模型上下文及会话历史；只有用户允许的应用可被模型操作。配置命令只进行安装、诊断与范围管理。
- 已执行的输入无法撤销。错误、取消或超时后，先检查窗口状态再重试。不保证锁屏、睡眠或所有 macOS 应用可用。
- 自动测试使用模拟驱动，不等于完成真实点击验收；真实操作需在系统授权后验证。

## 卸载

随包版本可在「插件 → 本地扩展」卸载或重新安装。若手动安装过独立包，也可以完全退出 asHub，再执行发布包中的 `node scripts/uninstall.mjs`。设置和下载的运行组件会保留，重新安装时可继续使用。

## 开发与验证

从源码测试时，先在 macOS 上构建截图组件。

```sh
npm install --ignore-scripts
npm run build:capture
npm test
```

测试用 agent-sh 0.16.0；分发文件为预编译 ESM，只依赖 Node.js 内置模块，使用宿主提供的扩展上下文。开发测试可设置 `ASHUB_TEST_ROOT` 指向 asHub 源码，以验证原版 PluginRuntime 加载、配置与生命周期。

分发 ZIP 时，从 `npm run pack:plugin` 生成的 TGZ 解出 `package/`，将目录改名为 `ashub-desktop-control-<版本>` 后整体压缩，保留 `native/capture` 的可执行权限。

本插件依据 [arc-cua](https://github.com/shhivv/arc-cua) 的协议实现，固定驱动提交 `6b353039111c08c2c64c5229083606941e364eaf`；其 Python 依赖按该版本声明安装。方案参考 [third-hand](https://github.com/shhivv/third-hand)，没有引入额外规划服务或账号。两者为 MIT 许可，驱动许可见 [docs/arc-cua-license.txt](docs/arc-cua-license.txt)。

## 0.2.0 插件协作接口

新增 `desktop-control:bridge:v1`，供微信等独立插件延迟连接。消费者复用现有 DesktopService 和任务队列，独立持有窗口授权与生命周期；不需要修改 asHub 主程序。窗口图像引用一次有效，取消、停用、配置变更与退出会撤销控制。接口不提供全局停止或任意驱动 RPC。

微信插件还需安装自己的包并启用 `wechat` 配置。desktop-control 的原有八个桌面工具保持可用，原来 0.1.0 的设置与驱动可以继续复用。

## 0.2.1 窗口观察优化

插件协作接口在同一任务内一次性复用 250 毫秒内的获取窗口或操作完成后的观察；每次 capture 仍请求新截图，窗口归属、权限和驱动失效检查保持有效。过期观察重新获取，取消立即失效。接口同时提供只含数字的分段耗时，原有桌面工具和配置保持兼容。

## 0.3.0 可选窗口捕获组件

macOS 14+ 可在现有 `desktop-control` 配置中增加 `"captureBackend": "screencapturekit"`，使用随包附带的 Intel / Apple Silicon 通用组件。省略此项或设为 `"legacy"` 时继续使用原有截图路径；不会自动切换配置。发布包安装不需要 Swift 编译器，源码重建组件需要 Xcode Command Line Tools。

新路径只捕获授权窗口，检查进程、窗口、尺寸及取消状态；纯色空图会明确报错，不自动退回整屏截图。失败会使前一张截图的坐标引用失效。

**该组件尚未解决本机微信 4.1.15 的捕获问题。** 单窗口路径仍为空白；另行测试的前台区域截取返回了微信背后的应用，而非微信内容，因此不提供该路径。安装新版不代表微信收发已经可用。完整结果见 [捕获验证记录](docs/capture-validation.md)。

## 0.3.1 审批取消修复

`desktop_start` 等待审批时，停止任务、取消对话或卸载插件会结束该工具调用，无需等待审批窗口回复；迟到的批准不会启动桌面操作。

## 0.3.2 驱动安装恢复

已有驱动目录缺少完成标记或 Python 文件时，`/desktop install` 可在新组件验证通过后替换不完整目录，避免反复报 `ENOTEMPTY`。准备失败保留旧目录；最终替换失败则回滚。已完整安装的组件保持不变。

## asHub 快速安装

在支持快速安装的新版 asHub 中打开「插件 → 安装插件」，选择本插件 ZIP，检查预览后确认安装。旧版客户端仍可使用 scripts/install.mjs。安装完成后完全退出并重启 asHub，保留原有配置；系统权限需手动授予。


## 0.3.4 插件协作接口

公共桥接接口 `desktop-control:bridge:v1` 新增只读 `cancellationSignal`。调用方应在整个复合操作开始时读取一次，将它与自己的取消信号合并，贯穿窗口检查、释放窗口后的审批等待和再次取得窗口等阶段。全局停止或插件销毁时该信号中止；新操作可重新读取新的信号。

这是兼容性扩展；原有工具、配置、捕获后端与 Python 环境不变。微信插件 0.3.0 依赖此接口，升级时先安装 desktop-control 0.3.4，再安装微信插件。

## 0.3.5

保留安装预检、Python 健康检查和运行环境修复。审批提示显示具体窗口，纯文本模型请求截图后仍能读取已授权窗口的无障碍控件。窗口尺寸变化时会拦截旧截图坐标，重新截图后可继续操作。
