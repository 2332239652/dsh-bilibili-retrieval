/**
 * Frame sampling — "watch the video" without ffmpeg.
 *
 * `x/player/videoshot` answers anonymously and returns a sprite sheet: one JPEG
 * holding a grid of sampled frames, plus the grid geometry. Measured on a
 * 221-second video: 4800x2700 JPEG, 264 KB, `img_x_len=10, img_y_len=10,
 * img_x_size=480, img_y_size=270`.
 *
 * Two measured caveats:
 *
 *  - The `index` array (per-frame timestamps) is unreliable: the same video
 *    returned 45 entries on one request and 0 on the next. Frame geometry must
 *    therefore come from `img_x_len * img_y_len`, never from `index.length`.
 *  - `index` entries are NOT x/y pairs; on a 45-frame sheet it held 45 numbers
 *    spaced 5 seconds apart. Treat it as optional timing metadata only.
 *
 * The sheet is returned whole rather than sliced: the plugin imports no image
 * library (installed via `link:`, so nothing is resolvable), and a 10x10 grid
 * reads fine for a multimodal model.
 */

import { BiliError } from "./protocol.js";

/** Cap on the sprite we are willing to hand to a model. */
const MAX_SPRITE_BYTES = 4 * 1024 * 1024;

/**
 * Fetch the preview sprite for one page.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {number} aid - numeric video id.
 * @param {number} cid - page id.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<object>} sprite metadata, or a cover fallback.
 */
export async function frameSprite(client, aid, cid, signal) {
  const data = await client.requestJson(
    "anonymous",
    "https://api.bilibili.com/x/player/videoshot?aid=" + aid + "&cid=" + cid + "&index=1",
    { cacheTtlMs: 7 * 24 * 60 * 60 * 1000, signal }
  );

  const sheets = Array.isArray(data?.image) ? data.image : [];
  if (sheets.length === 0) {
    throw new BiliError("BILIBILI_SPRITE_UNAVAILABLE", "this video has no preview sprite");
  }
  const raw = String(sheets[0]);
  const url = raw.startsWith("//") ? "https:" + raw : raw;
  const columns = Number(data?.img_x_len ?? 0);
  const rows = Number(data?.img_y_len ?? 0);
  const cellWidth = Number(data?.img_x_size ?? 0);
  const cellHeight = Number(data?.img_y_size ?? 0);

  return {
    url,
    sheetCount: sheets.length,
    columns,
    rows,
    cellWidth,
    cellHeight,
    frameCount: columns > 0 && rows > 0 ? columns * rows : 0,
    // Timing metadata when present; absent on many videos.
    timestamps: Array.isArray(data?.index) ? data.index.map(Number) : [],
    sheetWidth: columns * cellWidth,
    sheetHeight: rows * cellHeight,
  };
}

/**
 * Download a sprite as raw bytes, refusing anything oversized.
 * @param {string} url - absolute sprite URL.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<{bytes: number, contentType: string, data: Uint8Array}>}
 */
export async function downloadSprite(url, signal) {
  const timeout = AbortSignal.timeout(20000);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) {
    throw new BiliError("BILIBILI_SPRITE_UNAVAILABLE", "sprite download answered HTTP " + response.status);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_SPRITE_BYTES) {
    throw new BiliError(
      "BILIBILI_SPRITE_TOO_LARGE",
      "sprite is " + buffer.byteLength + " bytes, above the " + MAX_SPRITE_BYTES + "-byte cap"
    );
  }
  return {
    bytes: buffer.byteLength,
    contentType: response.headers.get("content-type") ?? "image/jpeg",
    data: buffer,
  };
}

/**
 * Resolve the directory a rendered image should be written to so the client can
 * preview it.
 *
 * `process.cwd()` is NOT the session workspace: the desktop host runs with its
 * profile directory as cwd, so writing there produces a path under `$DSH_HOME`
 * that the client renders as a broken image. The authoritative value is the
 * `workingDirectory` service's per-session projection, read through
 * `get(session)`.
 *
 * @param {object} ctx - plugin context (may not have the service mounted).
 * @param {object} exec - tool execution context.
 * @returns {Promise<string>} an absolute directory that exists, or "" when none
 *   could be resolved.
 */
export async function previewDirectory(ctx, exec) {
  const { mkdir } = await import("node:fs/promises");
  const { isAbsolute, resolve } = await import("node:path");

  const candidates = [];
  try {
    const service = ctx?.get?.("workingDirectory");
    const session = exec?.agent?.session;
    if (service !== undefined && session !== undefined) {
      const viaService = service.get(session);
      if (typeof viaService === "string" && isAbsolute(viaService)) candidates.push(viaService);
    }
  } catch {
    // Service shape changed; fall through to the remaining candidates.
  }
  candidates.push(process.cwd());

  for (const candidate of candidates) {
    // The install directory is never a workspace.
    if (/app\.asar|Programs[\\/]DeepSeek|resources[\\/]runtime/i.test(candidate)) continue;
    if (/[\\/]\.dsh[\\/]profiles[\\/]/i.test(candidate)) continue;
    try {
      const dir = resolve(candidate, "bili-frames");
      await mkdir(dir, { recursive: true });
      return dir;
    } catch {
      continue;
    }
  }
  return "";
}

/**
 * Write sprite bytes to ONE location, then prune older sheets.
 *
 * Only one copy is kept on purpose: an earlier version wrote to both the
 * workspace and `$DSH_HOME`, which doubled the disk cost for no benefit. The
 * workspace wins because that is what the client previews; `$DSH_HOME` is used
 * only when no workspace could be resolved.
 *
 * Retention is enforced on every write, so the directory can never grow without
 * bound: the oldest sheets are deleted until both the file count and the total
 * byte budget are satisfied.
 *
 * @param {Uint8Array} bytes - image bytes.
 * @param {string} name - file stem.
 * @param {object} config - plugin config.
 * @param {string} [preferredDir] - directory from {@link previewDirectory}.
 * @returns {Promise<string>} the path written, or "" when both targets failed.
 */
export async function cacheSprite(bytes, name, config, preferredDir = "") {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  const safe = String(name).replace(/[^0-9A-Za-z_-]/g, "_");
  const file = safe + ".jpg";

  let target = "";
  if (preferredDir.length > 0) {
    try {
      await mkdir(preferredDir, { recursive: true });
      target = join(preferredDir, file);
      await writeFile(target, bytes);
    } catch {
      target = "";
    }
  }
  if (target.length === 0) {
    try {
      const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
      const dir = join(home, "bili", "frames");
      await mkdir(dir, { recursive: true });
      target = join(dir, file);
      await writeFile(target, bytes);
    } catch {
      return "";
    }
  }

  await pruneFrames(preferredDir, config);
  return target;
}

/**
 * Delete the oldest frame sheets until the directory fits its budget.
 *
 * The sheet just written is never removed, so a caller always gets a usable
 * path even when a single sheet exceeds the byte budget.
 *
 * @param {string} dir - directory to prune; a no-op when empty.
 * @param {object} config - plugin config (`framesMaxFiles`, `framesMaxBytes`).
 * @returns {Promise<{removed: number, freedBytes: number}>} what was deleted.
 */
export async function pruneFrames(dir, config) {
  if (typeof dir !== "string" || dir.length === 0) return { removed: 0, freedBytes: 0 };
  const { readdir, stat, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const maxFiles = Math.max(1, Number(config?.framesMaxFiles ?? 12));
  const maxBytes = Math.max(0, Number(config?.framesMaxBytes ?? 24 * 1024 * 1024));

  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { removed: 0, freedBytes: 0 };
  }

  const sheets = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".jpg")) continue;
    try {
      const info = await stat(join(dir, entry));
      if (!info.isFile()) continue;
      sheets.push({ name: entry, size: info.size, at: info.mtimeMs });
    } catch {
      continue;
    }
  }
  // Newest first: the head of this list is what the caller just asked for.
  sheets.sort((a, b) => b.at - a.at);

  let removed = 0;
  let freedBytes = 0;
  let keptBytes = 0;
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    const overCount = index >= maxFiles;
    const overBytes = maxBytes > 0 && keptBytes + sheet.size > maxBytes;
    // Always keep the newest sheet, whatever the budget says.
    if (index > 0 && (overCount || overBytes)) {
      try {
        await unlink(join(dir, sheet.name));
        removed += 1;
        freedBytes += sheet.size;
        continue;
      } catch {
        // Fall through and count it as kept.
      }
    }
    keptBytes += sheet.size;
  }
  return { removed, freedBytes };
}

/**
 * Report the frame cache footprint across every location this plugin can write
 * to, so a stale directory from an older version is visible rather than silently
 * consuming space.
 *
 * `workspaceDir` must be the resolved session workspace, not `process.cwd()`:
 * the desktop host runs with its profile directory as cwd, so a cwd-based scan
 * reports an empty cache while sheets actually sit in the workspace. That exact
 * mistake made the first version of this report claim "nothing on disk" with a
 * 472 KB sheet present.
 *
 * @param {object} config - plugin config.
 * @param {string} [workspaceDir] - resolved workspace directory.
 * @returns {Promise<object[]>} one row per location that exists.
 */
export async function frameCacheReport(config, workspaceDir = "") {
  const { readdir, stat } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join, resolve } = await import("node:path");

  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const candidates = [
    workspaceDir.length > 0 ? resolve(workspaceDir, "bili-frames") : "",
    join(home, "bili", "frames"),
    join(home, "profiles", "desktop", "bili-frames"),
    join(process.cwd(), "bili-frames"),
  ].filter((dir) => dir.length > 0);
  const seen = new Set();
  const rows = [];
  for (const dir of candidates) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    try {
      const entries = await readdir(dir);
      let files = 0;
      let bytes = 0;
      for (const entry of entries) {
        if (!entry.toLowerCase().endsWith(".jpg")) continue;
        try {
          const info = await stat(join(dir, entry));
          if (info.isFile()) {
            files += 1;
            bytes += info.size;
          }
        } catch {
          continue;
        }
      }
      if (files > 0) rows.push({ dir, files, bytes });
    } catch {
      continue;
    }
  }
  return rows;
}

/**
 * Delete every frame sheet in a directory.
 * @param {string} dir - directory to clear.
 * @returns {Promise<{removed: number, freedBytes: number}>} what was deleted.
 */
export async function clearFrames(dir) {
  const { readdir, stat, unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let removed = 0;
  let freedBytes = 0;
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return { removed, freedBytes };
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".jpg")) continue;
    const target = join(dir, entry);
    try {
      const info = await stat(target);
      if (!info.isFile()) continue;
      await unlink(target);
      removed += 1;
      freedBytes += info.size;
    } catch {
      continue;
    }
  }
  return { removed, freedBytes };
}
