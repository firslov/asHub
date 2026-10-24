import { toast } from "./toast.js";
import { t } from "./i18n.js";

const downloads = new WeakSet();
const pending = new WeakSet();

// Resolve against the message's conversation, including background tabs.
export function artifactLink(href, base) {
  const url = new URL(href, base);
  if (url.origin !== location.origin) return null;
  if (/^\/[0-9a-f]{4,32}\/(?:index.html)?$/.test(url.pathname)) return null;
  const match = url.pathname.match(/^\/([0-9a-f]{4,32})\/(.+)$/);
  if (match?.[2] === 'artifacts' && url.searchParams.has('path')) return url;
  // URL resolution removes ../ before route matching. Keep relative file
  // paths intact so the server, not navigation, checks directory boundaries.
  const owner = new URL(base).pathname.match(/^\/([0-9a-f]{4,32})(?:\/|$)/);
  const relative = href.trim().split(/[?#]/)[0];
  if (owner && relative && !/^(?:[a-z][a-z0-9+.-]*:|[/\\])/i.test(relative)) {
    const result = new URL('/' + owner[1] + '/artifacts', location.origin);
    result.searchParams.set('path', decodeURIComponent(relative));
    return result;
  }
  if (!match || match[2] === 'index.html') return null;
  if (match[2] === 'artifacts') return url;
  if (!/\.[^/]+$/.test(match[2])) return null;
  const result = new URL('/' + match[1] + '/artifacts', location.origin);
  result.searchParams.set('path', decodeURIComponent(match[2]));
  return result;
}

async function downloadArtifact(a, url) {
  if (pending.has(a)) return;
  pending.add(a);
  try {
    const response = await fetch(url.href, { method: 'HEAD' });
    if (!response.ok || !response.headers.get('Content-Disposition')?.startsWith('attachment;')) throw new Error(String(response.status));
    const link = document.createElement('a');
    link.href = url.href;
    link.download = (url.searchParams.get('path') || '').split('/').pop() || 'download';
    // Even if the file disappears after HEAD, never replace the conversation.
    link.target = '_blank'; link.rel = 'noopener';
    downloads.add(link); document.body.append(link); link.click(); link.remove();
  } catch { toast(t('files.downloadFailed'), { type: 'error' }); }
  finally { pending.delete(a); }
}

document.addEventListener("click", (ev) => {
  const a = ev.target.closest?.("a");
  if (!a) return;
  if (ev.defaultPrevented || downloads.has(a)) return;
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;

  let isExternal = false;
  try {
    const sid = a.closest('session-view')?.getAttribute('session-id');
    const base = sid ? location.origin + '/' + sid + '/' : location.href;
    const file = artifactLink(href, base);
    if (file) { ev.preventDefault(); void downloadArtifact(a, file); return; }
    const u = new URL(href, base);
    isExternal = u.origin !== location.origin;
  } catch {
    // Malformed workspace URLs must not strand the app on an error page.
    ev.preventDefault(); toast(t('files.downloadFailed'), { type: 'error' });
    return;
  }

  if (!isExternal) return;

  ev.preventDefault();
  if (window.electronAPI?.openExternal) {
    window.electronAPI.openExternal(href).catch(() => {});
  } else {
    window.open(href, "_blank", "noopener,noreferrer");
  }
});
