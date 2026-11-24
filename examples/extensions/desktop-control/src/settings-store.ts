import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/** A synchronous transaction cannot interleave with another Hub/bridge writer.
 * Rename keeps readers from observing a truncated settings file. */
export function updateSettingsFile(file: string, update: (data: Record<string, any>) => Record<string, any>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let data: Record<string, any> = {};
  try { data = JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid settings object");
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(update(data), null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
}
