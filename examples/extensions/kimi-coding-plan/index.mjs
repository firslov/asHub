import { resolveHome, sharedAuth, KimiClient } from "./auth.mjs";
import { catalog, registration } from "./provider.mjs";
import { startProxy } from "./proxy.mjs";
import { deviceLogin, openAuthorization } from "./login.mjs";
const ID = "kimi-coding-plan";
export default async function activate(ctx) {
  if (!ctx.agent) return;
  const config = ctx.getExtensionSettings(ID, {
    kimiHome: "",
    effort: "default",
  });
  if (
    typeof config.kimiHome !== "string" ||
    typeof config.effort !== "string" ||
    !["default", "off", "low", "high", "max"].includes(config.effort)
  )
    throw Error("无效的 Kimi 插件配置");
  const auth = sharedAuth(resolveHome(config.kimiHome));
  const key = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
  const client = new KimiClient(auth, key);
  let models = [],
    proxy = null,
    disposed = false,
    pending,
    unregister,
    loginController,
    lastDiagnostic = "";
  const lifecycle = new AbortController();
  const info = (message) => {
    if (!disposed) ctx.bus.emit("ui:info", { message });
  };
  const refresh = (timeout = 45000) =>
    (pending ??= (async () => {
      const res = await client.request("/models", {
        signal: AbortSignal.any([
          lifecycle.signal,
          AbortSignal.timeout(timeout),
        ]),
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw Error(`Kimi 模型列表读取失败（HTTP ${res.status}）`);
      }
      const next = catalog(await res.json());
      if (disposed) return;
      if (!proxy) {
        const created = await startProxy({
          client,
          models: () => models,
          effort: config.effort,
          onDiagnostic: (message) => {
            if (message !== lastDiagnostic) info(message);
            lastDiagnostic = message;
          },
        });
        if (disposed) {
          await created.close();
          return;
        }
        proxy = created;
        ctx.agent.providers.configure(ID, {
          reasoningParams: () => ({}),
          requestHeaders: proxy.requestHeaders,
          cacheTokens: (u) =>
            u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens,
        });
      }
      models = next;
      const previousRegistration = unregister;
      unregister = ctx.agent.providers.register({
        id: ID,
        apiKey: proxy.secret,
        baseURL: proxy.baseURL,
        defaultModel: models[0].id,
        models: registration(models),
        supportsReasoningEffort: false,
      });
      previousRegistration?.();
    })().finally(() => (pending = null)));
  ctx.onDispose(() => {
    disposed = true;
    lifecycle.abort();
    loginController?.abort();
    unregister?.();
    void proxy?.close();
  });
  // Slash commands are optional in asHub; disabling that component must not
  // disable the provider itself. The built-in registry always defines /help.
  if (ctx.list().includes("command:/help")) {
    ctx.registerCommand(
      "kimi-login",
      "通过 Kimi 官方网页登录；/kimi-login cancel 取消",
      (args = "") => {
        if (args.trim() === "cancel") {
          loginController?.abort();
          info("Kimi 网页登录已取消");
          return;
        }
        if (args.trim()) {
          info("使用 /kimi-login 发起网页授权，或 /kimi-login cancel 取消");
          return;
        }
        if (key) {
          info(
            "当前使用 KIMI_API_KEY / MOONSHOT_API_KEY 环境变量。请移除该配置并重启 asHub 后使用网页登录",
          );
          return;
        }
        loginController?.abort();
        const controller = new AbortController();
        loginController = controller;
        void deviceLogin(auth, {
          signal: controller.signal,
          onAuthorization: ({ url, userCode }) => {
            if (disposed || controller.signal.aborted) return;
            info(
              `请在 Kimi 官方网页完成登录授权：${url}\n验证码：${userCode}\n等待网页确认；输入 /kimi-login cancel 可取消`,
            );
            openAuthorization(url);
          },
        })
          .then(async () => {
            if (disposed || controller.signal.aborted) return;
            lastDiagnostic = "";
            info("Kimi 网页登录成功。登录不代表套餐权限已验证");
            // A request already in flight may belong to the previous account.
            // Let it settle, then fetch a new catalog using the saved login.
            await pending?.catch(() => {});
            if (disposed || controller.signal.aborted) return;
            await refresh();
            if (disposed || controller.signal.aborted) return;
            info(`Kimi 模型已更新：${models.map((m) => m.id).join("、")}`);
          })
          .catch((e) => {
            if (!controller.signal.aborted) info(`Kimi 网页登录：${e.message}`);
          })
          .finally(() => {
            if (loginController === controller) loginController = null;
          });
      },
    );
    ctx.registerCommand(
      "kimi-refresh",
      "重新读取 Kimi 登录状态与模型列表",
      async () => {
        try {
          await refresh();
          info(
            `Kimi Coding Plan 已就绪：${models.map((m) => m.id).join("、")}`,
          );
        } catch (e) {
          info(e.message);
        }
      },
    );
    ctx.registerCommand(
      "kimi-status",
      "查看 Kimi Coding Plan 状态（不显示凭据）",
      () =>
        info(
          `Kimi Coding Plan · ${key ? "API Key" : "Kimi Code 登录"}\n${models.length ? "可用模型：" + models.map((m) => m.id).join("、") : "尚未连接，请运行 /kimi-login 完成网页授权"}\n思考设置：${config.effort}${loginController ? "\n正在等待网页登录" : ""}${lastDiagnostic ? "\n最近请求：" + lastDiagnostic : ""}`,
        ),
    );
  }
  // Signed-out/offline sessions must still open normally.
  try {
    await refresh(7500);
  } catch (e) {
    info("Kimi Coding Plan：" + e.message);
  }
}
