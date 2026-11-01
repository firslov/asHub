/** Read the small metadata envelope without parsing a potentially multi-megabyte
 * tool result/image. Noncanonical legacy frames retain the general JSON path. */
export function replayEventName(frame: string): string {
  const firstLine = frame.startsWith('data: ');
  const marker = firstLine ? 0 : frame.indexOf('\ndata: ');
  if (marker < 0) return '';
  const start = marker + (firstLine ? 6 : 7);
  const name = (meta: unknown) => {
    const value = (meta as { name?: unknown } | null)?.name;
    return typeof value === 'string' ? value : '';
  };
  const end = frame.indexOf('\n', start);
  const lineEnd = end < 0 ? frame.length : end;
  if (frame[lineEnd - 1] === '}' && frame.startsWith('{"meta":{', start)) {
    let depth = 0, quoted = false, escaped = false;
    const metaStart = start + 8;
    for (let i = metaStart; i < Math.min(frame.length, metaStart + 4096); i++) {
      const c = frame[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { return name(JSON.parse(frame.slice(metaStart, i + 1))); }
        catch { break; }
      }
    }
  }
  try { return name(JSON.parse(frame.slice(start, end < 0 ? undefined : end)).meta); }
  catch { return ''; }
}
