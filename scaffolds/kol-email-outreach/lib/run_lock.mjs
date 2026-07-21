import { randomUUID } from "crypto";
import { open, readFile, rename, stat, unlink } from "fs/promises";

async function readOwner(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    return {};
  }
}

async function releaseIfOwned(filePath, ownerToken) {
  const current = await readOwner(filePath);
  if (!current || current.owner_token !== ownerToken) return false;
  const released = `${filePath}.released.${ownerToken}`;
  try {
    await rename(filePath, released);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  await unlink(released).catch(() => {});
  return true;
}

export async function withRunLock(filePath, task, options = {}) {
  const staleMs = options.staleMs || 2 * 60 * 60 * 1000;
  const heartbeatMs = options.heartbeatMs || Math.max(1000, Math.min(30000, Math.floor(staleMs / 3)));
  const ownerToken = randomUUID();
  let handle;
  try {
    handle = await open(filePath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = await readOwner(filePath);
    const info = await stat(filePath).catch(() => null);
    const ageMs = info ? Math.max(0, Date.now() - info.mtimeMs) : null;
    const staleHint = ageMs != null && ageMs > staleMs ? " (stale-looking, but automatic takeover is disabled)" : "";
    throw new Error(
      `outreach run already active: ${filePath}${staleHint}; reconcile journal/Sent mail before manual lock removal` +
      (owner?.pid ? `; owner pid=${owner.pid}` : ""),
    );
  }

  let heartbeatBusy = false;
  let heartbeat;
  try {
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      owner_token: ownerToken,
      started_at: new Date().toISOString(),
    }));
    await handle.sync();
    heartbeat = setInterval(async () => {
      if (heartbeatBusy) return;
      heartbeatBusy = true;
      try {
        const now = new Date();
        await handle.utimes(now, now);
      } catch {
        // A failed heartbeat must not crash a live send; PID liveness still keeps the lock fail-closed.
      } finally {
        heartbeatBusy = false;
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    return await task();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await handle.close().catch(() => {});
    await releaseIfOwned(filePath, ownerToken).catch(() => {});
  }
}
