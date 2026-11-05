import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
export const API = "https://api.kimi.com/coding/v1";
const OAUTH = "https://auth.kimi.com/api/oauth/token";
const CLIENT = "17e5f671-d194-4dfb-9706-5516cb48c098";
const stores = new Map();
// Only explicit, locally constructed auth errors may expose their message.
export class KimiAuthError extends Error {
  constructor(message, status = 401, headers = {}) {
    super(message);
    this.name = "KimiAuthError";
    this.status = status;
    this.retryHeaders = headers;
  }
}
export function retryHeaders(headers) {
  const result = {};
  for (const name of ["retry-after", "retry-after-ms", "x-should-retry"]) {
    const value = headers.get(name);
    if (value !== null) result[name] = value;
  }
  return result;
}
export function resolveHome(configured) {
  if (configured) {
    if (!path.isAbsolute(configured)) throw Error("kimiHome 必须是绝对路径");
    return configured;
  }
  const next =
    process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
  if (
    existsSync(path.join(next, "credentials", "kimi-code.json")) ||
    process.env.KIMI_CODE_HOME
  )
    return next;
  const old = path.join(os.homedir(), ".kimi");
  return existsSync(path.join(old, "credentials", "kimi-code.json"))
    ? old
    : next;
}
export function sharedAuth(home) {
  const key = path.resolve(home);
  if (!stores.has(key)) stores.set(key, new Credentials(key));
  return stores.get(key);
}
export class Credentials {
  constructor(home, fetchImpl = (...args) => fetch(...args)) {
    this.home = home;
    this.file = path.join(home, "credentials", "kimi-code.json");
    this.fetch = fetchImpl;
    this.pending = null;
  }
  async load() {
    let data;
    try {
      data = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      throw new KimiAuthError(
        "未找到有效的 Kimi Code 登录，请运行 /kimi-login 完成网页授权，或运行 kimi login 后执行 /kimi-refresh",
      );
    }
    if (
      !data ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      !Number.isFinite(data.expires_at)
    )
      throw new KimiAuthError(
        "Kimi Code 登录已失效，请重新运行 /kimi-login（或 kimi login）",
      );
    return data;
  }
  async headers() {
    let device = "";
    try {
      device = (
        await fs.readFile(path.join(this.home, "device_id"), "utf8")
      ).trim();
    } catch {}
    return {
      "User-Agent": "asHub-kimi-coding-plan/0.2.1",
      "X-Msh-Platform": "asHub",
      "X-Msh-Version": "0.2.1",
      ...(device && /^[\x20-\x7e]{1,200}$/.test(device)
        ? { "X-Msh-Device-Id": device }
        : {}),
    };
  }
  async saveLogin(data, signal) {
    if (
      !data ||
      typeof data.access_token !== "string" ||
      !data.access_token ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token ||
      !Number.isFinite(Number(data.expires_in)) ||
      Number(data.expires_in) <= 0
    ) {
      throw Error("Kimi 返回的网页登录凭据格式无效");
    }
    signal?.throwIfAborted();
    const target = path.join(this.home, "oauth", "kimi-code");
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, "", { flag: "a", mode: 0o600 });
    let compromised;
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: 5000,
      retries: { retries: 60, factor: 1, minTimeout: 500, maxTimeout: 500 },
      onCompromised: (e) => (compromised = e),
    });
    const temp = this.file + ".tmp." + randomUUID();
    try {
      signal?.throwIfAborted();
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const next = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in),
        expires_in: Number(data.expires_in),
        token_type:
          typeof data.token_type === "string" ? data.token_type : "Bearer",
        scope: typeof data.scope === "string" ? data.scope : "",
      };
      const file = await fs.open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
      signal?.throwIfAborted();
      if (compromised) throw Error("Kimi 登录保存锁已失效，请重试");
      await fs.rename(temp, this.file);
    } finally {
      try {
        await fs.rm(temp, { force: true });
      } finally {
        await release().catch(() => {});
      }
    }
  }
  async get(staleToken) {
    if (this.pending) {
      await this.pending;
      return this.get(staleToken);
    }
    const current = await this.load();
    if (
      current.expires_at > Date.now() / 1000 + 60 &&
      current.access_token !== staleToken
    )
      return current.access_token;
    // load() yields: recheck before starting a second refresh in this process.
    if (this.pending) {
      await this.pending;
      return this.get(staleToken);
    }
    const pending = this.refresh(staleToken);
    this.pending = pending;
    try {
      return await pending;
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }
  async refresh(staleToken) {
    const target = path.join(this.home, "oauth", "kimi-code");
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, "", { flag: "a", mode: 0o600 });
    let compromised;
    const release = await lockfile.lock(target, {
      realpath: false,
      stale: 5000,
      retries: { retries: 60, factor: 1, minTimeout: 500, maxTimeout: 500 },
      onCompromised: (e) => {
        compromised = e;
      },
    });
    try {
      const prior = await this.load();
      if (
        prior.expires_at > Date.now() / 1000 + 60 &&
        prior.access_token !== staleToken
      )
        return prior.access_token;
      if (typeof prior.refresh_token !== "string" || !prior.refresh_token)
        throw new KimiAuthError(
          "Kimi 登录缺少刷新凭据，请运行 /kimi-login（或 kimi login）",
        );
      const response = await this.fetch(OAUTH, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          ...(await this.headers()),
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          client_id: CLIENT,
          grant_type: "refresh_token",
          refresh_token: prior.refresh_token,
        }).toString(),
      });
      if (!response.ok) {
        // OAuth uses HTTP 400 for expired/revoked refresh credentials. Read
        // only the machine code; never surface the server's credential details.
        const invalidGrant =
          response.status === 400 &&
          (await response.json().catch(() => null))?.error === "invalid_grant";
        if (response.status !== 400) await response.body?.cancel();
        const loginRequired =
          response.status === 401 || response.status === 403 || invalidGrant;
        throw new KimiAuthError(
          `Kimi 登录刷新失败（HTTP ${response.status}）${loginRequired ? "，请运行 /kimi-login（或 kimi login）" : "，请稍后重试"}；原凭据未删除`,
          loginRequired ? 401 : response.status,
          retryHeaders(response.headers),
        );
      }
      const data = await response.json();
      if (
        typeof data.access_token !== "string" ||
        !data.access_token ||
        !Number.isFinite(Number(data.expires_in)) ||
        Number(data.expires_in) <= 0
      )
        throw Error("Kimi 返回的刷新凭据格式无效");
      if (compromised) throw Error("Kimi 登录刷新锁已失效，请重试");
      const now = await this.load();
      if (
        now.access_token !== prior.access_token ||
        now.refresh_token !== prior.refresh_token
      )
        return now.access_token;
      const next = {
        ...prior,
        ...data,
        refresh_token: data.refresh_token || prior.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in),
      };
      const temp = this.file + ".tmp." + randomUUID();
      try {
        const handle = await fs.open(temp, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(next, null, 2) + "\n");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await fs.rename(temp, this.file);
      } finally {
        await fs.rm(temp, { force: true });
      }
      return next.access_token;
    } finally {
      await release().catch(() => {});
    }
  }
}
// Cancel the caller promptly without cancelling a refresh shared by other requests.
async function waitFor(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
export class KimiClient {
  constructor(auth, key, fetchImpl = (...args) => fetch(...args)) {
    this.auth = auth;
    this.key = key;
    this.fetch = fetchImpl;
  }
  async request(route, init = {}) {
    init.signal?.throwIfAborted();
    const token = this.key || (await waitFor(this.auth.get(), init.signal));
    const send = async (token) => {
      init.signal?.throwIfAborted();
      return this.fetch(API + route, {
        ...init,
        redirect: "error",
        headers: {
          ...(await this.auth.headers()),
          ...init.headers,
          Authorization: "Bearer " + token,
        },
      });
    };
    let response = await send(token);
    if (response.status === 401 && !this.key) {
      await response.body?.cancel();
      init.signal?.throwIfAborted();
      response = await send(await waitFor(this.auth.get(token), init.signal));
    }
    return response;
  }
}
