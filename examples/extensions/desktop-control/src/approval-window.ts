export function describeDesktopWindow(window: { window_id: number; title?: unknown }): string {
  const singleLine = typeof window.title === 'string'
    ? window.title.replace(/[\s\p{Cc}\p{Bidi_Control}]+/gu, ' ').trim()
    : '';
  const title = singleLine.match(/^.{0,160}/u)?.[0];
  return `Window ${window.window_id} · ${title || 'Untitled window'}`;
}
