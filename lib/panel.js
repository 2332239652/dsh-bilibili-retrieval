/**
 * Host-side HTTP surface for the control panel.
 *
 * The browser half (`lib/client.js`) cannot touch the filesystem or hold a
 * credential, so every privileged action lands here:
 *
 *   GET  /api/bilibili-retrieval/status   channel state, login, cache, config
 *   POST /api/bilibili-retrieval/qr       mint a login QR, return it as a data URL
 *   GET  /api/bilibili-retrieval/qr       poll the QR that was just minted
 *   POST /api/bilibili-retrieval/logout   forget the saved credential
 *   POST /api/bilibili-retrieval/cache    { action: "report" | "clear" }
 *   GET  /api/bilibili-retrieval/config   effective config
 *   POST /api/bilibili-retrieval/config   patch config keys (rate limits, caps)
 *
 * Two deliberate constraints:
 *
 *  - Same-origin only. A local HTTP server that mints login QR codes must never
 *    answer a cross-origin page, so the Origin/Referer is compared against the
 *    Host header before anything else runs.
 *  - No credential ever leaves this process. `status` reports the account name
 *    and mid; it never returns SESSDATA or the refresh token.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Route prefix, also used by the client as its API base. */
export const API_PREFIX = "/api/bilibili-retrieval";

/**
 * Write a JSON response, tolerating an already-closed socket.
 * @param {import("node:http").ServerResponse} res - response.
 * @param {number} code - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, code, payload) {
  try {
    res.writeHead(code, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(payload));
  } catch {
    // Connection already gone; nothing useful to do.
  }
}

/**
 * Reject anything that is not a loopback, same-origin request.
 *
 * A missing Origin/Referer is allowed: `curl` and the client's own fetch both
 * omit it for same-origin GETs, and the Host check already proves loopback.
 *
 * @param {import("node:http").IncomingMessage} req - request.
 * @returns {boolean} whether the request may proceed.
 */
function sameOriginOk(req) {
  const host = String(req.headers.host || "");
  if (host.length === 0) return true;
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false;

  const origin = String(req.headers.origin || req.headers.referer || "");
  if (origin.length === 0) return true;
  try {
    const parsed = new URL(origin);
    const expected = String(host).toLowerCase();
    const actual = String(parsed.host || "").toLowerCase();
    if (actual.length > 0 && actual === expected) return true;
    const defaultPort = parsed.protocol === "https:" ? "443" : "80";
    return (parsed.hostname + ":" + (parsed.port || defaultPort)).toLowerCase() === expected;
  } catch {
    return false;
  }
}

/**
 * Read and parse a JSON request body with a size cap.
 * @param {import("node:http").IncomingMessage} req - request.
 * @param {number} [limit] - maximum accepted bytes.
 * @returns {Promise<object>} parsed body, or an empty object.
 */
async function readJson(req, limit = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) return {};
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Resolve the frame-cache directory the host would write to.
 * Mirrors `lib/frames.js` so the panel reports the same place the tool uses.
 * @param {object} ctx - plugin context.
 * @returns {string} absolute directory.
 */
function frameDir(ctx) {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  // The tool writes into the session workspace; the panel cannot know that
  // session, so it reports the fallback location plus the workspace copy the
  // host process can see.
  return join(home, "bili", "frames");
}

/**
 * Mount the control-panel routes.
 *
 * @param {object} ctx - plugin context (must have `webServer` injected).
 * @param {object} deps - collaborators.
 * @param {() => object} deps.config - returns the effective config.
 * @param {object} deps.client - the shared BiliClient.
 * @param {object} deps.login - `{ createLoginQr, pollLogin, readCredential, clearCredential, verifyCredential, saveCredential }`.
 * @param {object} deps.frames - `{ frameCacheReport, clearFrames, pruneFrames }`.
 * @param {(patch: object) => object} deps.applyConfig - merges a config patch and returns the new config.
 * @returns {() => void} disposer.
 */
export function mountControlPanel(ctx, deps) {
  const { config, client, login, frames, applyConfig } = deps;

  // Headless hosts (CLI, tests) mount no webServer. The tools still work there,
  // there is just no UI, so treat a missing service as "no panel" rather than
  // failing the whole plugin.
  if (ctx === null || ctx === undefined || ctx.webServer === undefined || typeof ctx.webServer.register !== "function") {
    return () => {};
  }

  // The QR currently on screen. Kept in memory only: a minted key is a
  // short-lived login ticket, not something to write to disk.
  let pending = null;

  /** Build the payload the panel polls while waiting for a scan. */
  const describePending = () => {
    if (pending === null) return null;
    return {
      key: pending.key,
      url: pending.url,
      dataUrl: pending.dataUrl,
      issuedAt: pending.issuedAt,
      expiresAt: pending.expiresAt,
      state: pending.state,
      message: pending.message,
    };
  };

  const statusPayload = async () => {
    const resolved = config();
    const credential = await login.readCredential(resolved);
    let account = null;
    if (credential !== null) {
      try {
        const verified = await login.verifyCredential(resolved, credential);
        account = {
          valid: verified.ok === true,
          mid: verified.mid ?? null,
          name: verified.name ?? null,
          savedAt: credential.savedAt ?? null,
        };
      } catch {
        account = { valid: false, mid: null, name: null, savedAt: credential.savedAt ?? null };
      }
    }

    let cache = { files: 0, bytes: 0, dirs: [] };
    try {
      const rows = await frames.frameCacheReport(resolved, "");
      cache = {
        files: rows.reduce((n, row) => n + row.files, 0),
        bytes: rows.reduce((n, row) => n + row.bytes, 0),
        dirs: rows.map((row) => ({ dir: row.dir, files: row.files, bytes: row.bytes })),
      };
    } catch {
      // A missing directory is not an error worth surfacing.
    }

    return {
      ok: true,
      version: resolved.version ?? null,
      channels: {
        anonymous: {
          ready: true,
          minIntervalMs: resolved.anonMinIntervalMs,
          burst: resolved.anonBurst,
        },
        authenticated: {
          ready: credential !== null,
          minIntervalMs: resolved.authMinIntervalMs,
          burst: resolved.authBurst,
          maxPerSession: resolved.authMaxPerSession,
        },
      },
      account,
      cache: { ...cache, fallbackDir: frameDir(ctx), maxFiles: resolved.framesMaxFiles, maxBytes: resolved.framesMaxBytes },
      pending: describePending(),
      config: {
        anonMinIntervalMs: resolved.anonMinIntervalMs,
        anonBurst: resolved.anonBurst,
        authMinIntervalMs: resolved.authMinIntervalMs,
        authBurst: resolved.authBurst,
        authMaxPerSession: resolved.authMaxPerSession,
        requestTimeoutMs: resolved.requestTimeoutMs,
        framesMaxFiles: resolved.framesMaxFiles,
        framesMaxBytes: resolved.framesMaxBytes,
      },
    };
  };

  return ctx.webServer.register({
    kind: "prefix",
    path: API_PREFIX,
    handler: async (req, res) => {
      if (!sameOriginOk(req)) {
        return sendJson(res, 403, { ok: false, error: "only loopback same-origin requests are accepted" });
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      const route = url.pathname.slice(API_PREFIX.length).replace(/\/+$/, "") || "/";
      const method = String(req.method || "GET").toUpperCase();

      try {
        // ---------------------------------------------------------- status
        if (method === "GET" && route === "/status") {
          return sendJson(res, 200, await statusPayload());
        }

        // -------------------------------------------------------------- qr
        if (method === "POST" && route === "/qr") {
          const resolved = config();
          const qr = await login.createLoginQr(resolved, undefined, "");
          pending = {
            key: qr.qrcodeKey,
            url: qr.url,
            dataUrl: "data:image/png;base64," + Buffer.from(qr.png).toString("base64"),
            issuedAt: Date.now(),
            expiresAt: Date.now() + 175 * 1000,
            state: "waiting",
            message: "等待扫码",
          };
          return sendJson(res, 200, { ok: true, qr: describePending() });
        }

        if (method === "GET" && route === "/qr") {
          if (pending === null) {
            return sendJson(res, 200, { ok: true, qr: null });
          }
          const resolved = config();
          try {
            const poll = await login.pollLogin(resolved, pending.key);
            if (poll.state === "success") {
              await login.saveCredential(resolved, poll.credential);
              // Drop the session cap so a fresh login is immediately usable.
              if (typeof client.resetSession === "function") client.resetSession();
              pending = null;
              const payload = await statusPayload();
              return sendJson(res, 200, { ok: true, qr: null, loggedIn: true, status: payload });
            }
            if (poll.state === "expired") {
              const expired = { ...describePending(), state: "expired", message: "二维码已过期，请重新生成" };
              pending = null;
              return sendJson(res, 200, { ok: true, qr: expired });
            }
            pending.state = poll.state;
            pending.message = poll.state === "scanned" ? "已扫码，请在手机上确认" : "等待扫码";
            return sendJson(res, 200, { ok: true, qr: describePending() });
          } catch (error) {
            const message = String(error?.message ?? error);
            // A poll failure is not fatal: keep the QR so the user can retry.
            return sendJson(res, 200, { ok: false, error: message, qr: describePending() });
          }
        }

        // ---------------------------------------------------------- logout
        if (method === "POST" && route === "/logout") {
          const resolved = config();
          await login.clearCredential(resolved);
          if (typeof client.resetSession === "function") client.resetSession();
          return sendJson(res, 200, { ok: true, status: await statusPayload() });
        }

        // ----------------------------------------------------------- cache
        if (method === "POST" && route === "/cache") {
          const body = await readJson(req);
          const action = String(body.action ?? "report");
          const resolved = config();
          if (action === "clear") {
            const rows = await frames.frameCacheReport(resolved, "");
            let removed = 0;
            let freedBytes = 0;
            for (const row of rows) {
              const result = await frames.clearFrames(row.dir);
              removed += result.removed;
              freedBytes += result.freedBytes;
            }
            return sendJson(res, 200, { ok: true, removed, freedBytes, status: await statusPayload() });
          }
          return sendJson(res, 200, { ok: true, status: await statusPayload() });
        }

        // ---------------------------------------------------------- config
        if (method === "GET" && route === "/config") {
          return sendJson(res, 200, { ok: true, config: (await statusPayload()).config });
        }

        if (method === "POST" && route === "/config") {
          const body = await readJson(req);
          // Whitelist, so a typo cannot rewrite an unrelated key.
          const numeric = [
            "anonMinIntervalMs",
            "anonBurst",
            "authMinIntervalMs",
            "authBurst",
            "authMaxPerSession",
            "requestTimeoutMs",
            "framesMaxFiles",
            "framesMaxBytes",
          ];
          const patch = {};
          for (const key of numeric) {
            if (body[key] === undefined) continue;
            const value = Number(body[key]);
            if (!Number.isFinite(value) || value < 0) continue;
            patch[key] = Math.trunc(value);
          }
          if (Object.keys(patch).length === 0) {
            return sendJson(res, 400, { ok: false, error: "no recognized numeric keys in the body" });
          }
          const next = applyConfig(patch);
          return sendJson(res, 200, { ok: true, applied: patch, config: next });
        }

        return sendJson(res, 404, { ok: false, error: "unknown route " + method + " " + route });
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
    },
  });
}
