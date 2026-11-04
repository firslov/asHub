import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
export const OAUTH_CLIENT = "17e5f671-d194-4dfb-9706-5516cb48c098";
const HOST = "https://auth.kimi.com";
export function authorizationURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !["auth.kimi.com", "www.kimi.com", "kimi.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw Error("Kimi 返回了非官方授权地址");
  return url.href;
}
export function openAuthorization(
  url,
  platform = process.platform,
  launch = spawn,
) {
  url = authorizationURL(url);
  const [command, args] =
    platform === "darwin"
      ? ["open", [url]]
      : platform === "win32"
        ? [
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Start-Process -FilePath $env.ASHUB_KIMI_LOGIN_URL",
            ],
          ]
        : ["xdg-open", [url]];
  try {
    launch(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: { ...process.env, ASHUB_KIMI_LOGIN_URL: url },
    })
      .on("error", () => {})
      .unref();
  } catch {} // The same URL is shown in the chat for manual opening.
}
export async function deviceLogin(
  auth,
  {
    signal,
    onAuthorization,
    fetchImpl = (...args) => fetch(...args),
    sleep = delay,
  } = {},
) {
  signal?.throwIfAborted();
  const post = async (route, body, requestSignal) => {
    const response = await fetchImpl(HOST + route, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(30000),
        ...(requestSignal ? [requestSignal] : []),
      ]),
      headers: {
        ...(await auth.headers()),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: OAUTH_CLIENT,
        ...body,
      }).toString(),
    });
    const data = await response.json().catch(() => null);
    return { status: response.status, data };
  };
  const initial = await post("/api/oauth/device_authorization", {}, signal);
  if (initial.status !== 200)
    throw Error(`Kimi 网页授权发起失败（HTTP ${initial.status}）`);
  const d = initial.data,
    expires = Number(d?.expires_in ?? 600),
    step = Number(d?.interval ?? 5);
  if (
    !d ||
    typeof d.device_code !== "string" ||
    !d.device_code ||
    typeof d.user_code !== "string" ||
    !/^[A-Za-z0-9-]{1,64}$/.test(d.user_code) ||
    !Number.isFinite(expires) ||
    expires <= 0 ||
    !Number.isFinite(step) ||
    step <= 0
  )
    throw Error("Kimi 网页授权响应格式无效");
  const url = authorizationURL(
    d.verification_uri_complete ?? d.verification_uri,
  );
  const deadline = AbortSignal.timeout(
    Math.min(1800, Math.ceil(expires)) * 1000,
  );
  const combined = AbortSignal.any([deadline, ...(signal ? [signal] : [])]);
  let interval = Math.max(1, Math.min(60, step));
  try {
    combined.throwIfAborted();
    onAuthorization?.({
      url,
      userCode: d.user_code,
      expiresIn: Math.min(1800, expires),
    });
    for (;;) {
      await sleep(interval * 1000, undefined, { signal: combined });
      combined.throwIfAborted();
      const reply = await post(
        "/api/oauth/token",
        {
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: d.device_code,
        },
        combined,
      );
      combined.throwIfAborted();
      if (reply.status === 200) {
        await auth.saveLogin(reply.data, combined);
        return;
      }
      if (reply.data?.error === "authorization_pending") continue;
      if (reply.data?.error === "slow_down" || reply.status === 429) {
        interval = Math.min(60, interval + 5);
        continue;
      }
      if (reply.data?.error === "access_denied")
        throw Error("Kimi 网页授权已拒绝");
      if (reply.data?.error === "expired_token")
        throw Error("Kimi 网页授权已过期，请重新运行 /kimi-login");
      if (reply.status >= 500) continue;
      throw Error(
        `Kimi 网页授权失败（HTTP ${reply.status}），请重新运行 /kimi-login`,
      );
    }
  } catch (e) {
    if (deadline.aborted && !signal?.aborted)
      throw Error("Kimi 网页授权已过期，请重新运行 /kimi-login");
    throw e;
  }
}
