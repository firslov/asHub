import { createPolicyFetch } from "./network-policy.js";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** Node fetch does not automatically inherit the browser/system proxy. */
export function createEnvironmentProxy(env: NodeJS.ProcessEnv = process.env): EnvHttpProxyAgent | undefined {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? "";
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? "";
  if (!httpProxy && !httpsProxy) return undefined;
  const bypass = env.no_proxy ?? env.NO_PROXY ?? "";
  // Hub, remote connector and Codex's local proxy must never leave this machine.
  const noProxy = bypass.trim() === "*" ? "*" : [bypass, "localhost", "127.0.0.1", "[::1]"].filter(Boolean).join(",");
  return new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
}

export const nodeFetch = globalThis.fetch;
let configured = false;
export function configureNetwork(): void {
  if (configured) return;
  const dispatcher = createEnvironmentProxy();
  if (dispatcher) setGlobalDispatcher(dispatcher);
  globalThis.fetch = createPolicyFetch(nodeFetch, nodeFetch);
  configured = true;
}
