import * as fs from "node:fs";
import * as path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

/** Open only regular files contained by this conversation's real working directory. */
export async function openArtifact(cwd: string, requested: string) {
  const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
  if (!requested || requested.includes("\0")) throw fail(400, "Invalid file path");
  const root = await fs.promises.realpath(cwd);
  const inside = (target: string) => {
    const relative = path.relative(root, target);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };
  const candidate = path.resolve(root, requested);
  if (!inside(candidate)) throw fail(403, "File is outside this conversation's working directory");
  const resolved = await fs.promises.realpath(candidate);
  if (!inside(resolved)) throw fail(403, "File is outside this conversation's working directory");
  if (!(await fs.promises.stat(resolved)).isFile()) throw fail(404, "File not found");
  // Reject FIFOs and final-component symlink swaps without blocking a worker.
  const file = await fs.promises.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw fail(404, "File not found");
    return { file, stat, candidate };
  } catch (e) { await file.close(); throw e; }
}

/** Deliver workspace files as downloads, never as executable app-origin pages. */
export async function serveArtifact(req: IncomingMessage, res: ServerResponse, cwd: string, requested: string) {
  let file: fs.promises.FileHandle | undefined;
  try {
    const opened = await openArtifact(cwd, requested);
    file = opened.file;
    const { stat, candidate } = opened;
    const name = encodeURIComponent(path.basename(candidate)).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${name}`,
      "Content-Length": stat.size,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
    });
    if (req.method === "HEAD") { res.end(); return; }
    await pipeline(file.createReadStream({ autoClose: false }), res);
  } catch (e) {
    if (!res.headersSent && !res.destroyed) {
      const code = (e as NodeJS.ErrnoException).code;
      res.writeHead((e as { status?: number }).status || (code === "EACCES" || code === "EPERM" ? 403 : 404));
      res.end("File unavailable");
    } else if (!res.destroyed) res.destroy();
  } finally { await file?.close(); }
}
