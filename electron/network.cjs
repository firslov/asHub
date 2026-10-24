// Finder/Explorer launches normally have no shell proxy environment. Chromium
// follows the OS proxy (including PAC), whereas Node fetch connects directly.
function createDesktopFetch(systemFetch, nodeFetch = globalThis.fetch, env = process.env) {
  const httpProxy = env.http_proxy ?? env.HTTP_PROXY ?? '';
  const httpsProxy = env.https_proxy ?? env.HTTPS_PROXY ?? '';
  // network-bootstrap configures Undici for explicitly supplied proxy settings.
  if (httpProxy || httpsProxy) return nodeFetch;
  return function desktopFetch(input, init) {
    let url;
    try { url = new URL(input instanceof Request ? input.url : String(input)); }
    catch { return nodeFetch(input, init); }
    const host = url.hostname.toLowerCase();
    const loopback = host === 'localhost' || host.endsWith('.localhost')
      || /^127\./.test(host) || host === '[::1]';
    // Hub, connectors and the Codex conversion proxy always stay on this host.
    // Keep Node's handling of data URLs and other non-HTTP schemes as well.
    if (loopback || !['http:', 'https:'].includes(url.protocol)) return nodeFetch(input, init);
    // Node fetch never attaches browser cookies. Preserve that boundary when
    // moving API calls to Chromium; explicit Authorization headers still work.
    return systemFetch(input, { ...init, credentials: 'omit' });
  };
}
module.exports = { createDesktopFetch };
