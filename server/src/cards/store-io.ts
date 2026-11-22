/** Cards — file helpers shared by the server and the card worker (nothing here may reach the database). */
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";

export const sha1 = (data: string | Uint8Array) => createHash("sha1").update(data).digest("hex");

/** write a file atomically: a temporary file next to it, renamed into place */
export async function atomicWrite(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}
