/**
 * Scanned (QR) login for bilibili.
 *
 * The whole flow is drivable from plain HTTPS, so no browser is involved:
 *
 *  1. `passport.bilibili.com/x/passport-login/web/qrcode/generate` returns a
 *     `url` plus a `qrcode_key`. Note the host: the same path under
 *     `api.bilibili.com` answers 404.
 *  2. The `url` is rendered locally as a QR image (see `qr.js` — the plugin is
 *     installed via `link:`, so no npm QR library is resolvable).
 *  3. `.../qrcode/poll?qrcode_key=...` reports progress in `data.code`:
 *     `86101` not scanned, `86090` scanned and awaiting confirmation, `0`
 *     success, `86038` expired.
 *  4. On success `data.url` carries the cookies in its query string, and
 *     `data.refresh_token` can renew them later.
 *
 * The credential is written to its own file rather than `$DSH_HOME/.env`: every
 * `KEY=VALUE` line of `.env` is injected into every child process the harness
 * starts, which would spread a full login token far beyond this plugin.
 */

import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { BiliError, USER_AGENT } from "./protocol.js";
import { encode, toPng } from "./qr.js";

/** Host serving the QR endpoints. `api.bilibili.com` answers 404 for these. */
const PASSPORT = "https://passport.bilibili.com";

/** Poll states returned in `data.code`. */
export const QR_STATE = {
  SUCCESS: 0,
  EXPIRED: 86038,
  SCANNED: 86090,
  WAITING: 86101,
};

/**
 * Resolve where the credential file lives.
 * @param {object} config - plugin config.
 * @returns {string} absolute path.
 */
export function credentialFile(config) {
  const explicit = String(config?.credentialPath ?? "").trim();
  if (explicit.length > 0) return explicit;
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "bili", "credential.json");
}

/**
 * Path of the last rendered login QR, kept on disk as a fallback for when the
 * image cannot be shown inline.
 * @param {object} config - plugin config.
 * @returns {string} absolute path.
 */
export function qrImageFile(config) {
  return join(dirname(credentialFile(config)), "login-qr.png");
}

/**
 * Ask bilibili for a fresh login QR.
 *
 * The PNG is written twice: into `preferredDir` when the caller can resolve the
 * session workspace (that is the location the client previews), and into
 * `$DSH_HOME/bili/` as a fallback that always succeeds. A stable filename means
 * a re-issued QR replaces the previous image in place.
 *
 * @param {object} config - plugin config.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @param {string} [preferredDir] - workspace directory for the previewable copy.
 * @returns {Promise<{qrcodeKey: string, url: string, pngPath: string, png: Uint8Array, width: number}>}
 */
export async function createLoginQr(config, signal, preferredDir = "") {
  const timeout = AbortSignal.timeout(Number(config?.requestTimeoutMs ?? 20000));
  const response = await fetch(PASSPORT + "/x/passport-login/web/qrcode/generate", {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.bilibili.com/" },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  const body = await response.json();
  if (Number(body?.code) !== 0) {
    throw new BiliError("BILIBILI_QR_UNAVAILABLE", "could not obtain a login QR: " + String(body?.message ?? body?.code));
  }
  const url = String(body.data?.url ?? "");
  const qrcodeKey = String(body.data?.qrcode_key ?? "");
  if (url.length === 0 || qrcodeKey.length === 0) {
    throw new BiliError("BILIBILI_QR_UNAVAILABLE", "the QR response was missing url or qrcode_key");
  }

  const matrix = encode(url);
  const png = await toPng(matrix, { scale: 8, quietZone: 4 });

  let pngPath = "";
  if (preferredDir.length > 0) {
    try {
      await mkdir(preferredDir, { recursive: true });
      const target = join(preferredDir, "bili-login-qr.png");
      await writeFile(target, png);
      pngPath = target;
    } catch {
      pngPath = "";
    }
  }
  if (pngPath.length === 0) {
    try {
      const target = qrImageFile(config);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, png);
      pngPath = target;
    } catch {
      pngPath = "";
    }
  }

  return {
    qrcodeKey,
    url,
    pngPath,
    png,
    width: (matrix.size + 8) * 8,
    version: matrix.version,
  };
}

/**
 * Poll one already-issued QR key.
 * @param {object} config - plugin config.
 * @param {string} qrcodeKey - value from {@link createLoginQr}.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<{state: "waiting"|"scanned"|"expired"|"success", credential?: object}>}
 */
export async function pollLogin(config, qrcodeKey, signal) {
  const timeout = AbortSignal.timeout(Number(config?.requestTimeoutMs ?? 20000));
  const url =
    PASSPORT +
    "/x/passport-login/web/qrcode/poll?qrcode_key=" +
    encodeURIComponent(qrcodeKey) +
    "&source=main-fe-header";
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Referer: "https://www.bilibili.com/" },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  // Cookies arrive in BOTH places depending on the deployment: the redirect URL's
  // query string, and the Set-Cookie headers. Reading only the URL silently loses
  // a successful login — which is exactly what happened on the first real scan.
  const setCookies = response.headers.getSetCookie?.() ?? [];
  const body = await response.json();
  if (Number(body?.code) !== 0) {
    throw new BiliError("BILIBILI_QR_UNAVAILABLE", "QR poll failed: " + String(body?.message ?? body?.code));
  }
  const state = Number(body.data?.code);
  if (state === QR_STATE.WAITING) return { state: "waiting" };
  if (state === QR_STATE.SCANNED) return { state: "scanned" };
  if (state === QR_STATE.EXPIRED) return { state: "expired" };
  if (state === QR_STATE.SUCCESS) {
    const credential = credentialFromLoginUrl(
      String(body.data?.url ?? ""),
      String(body.data?.refresh_token ?? ""),
      setCookies
    );
    if (credential === null) {
      throw new BiliError(
        "BILIBILI_QR_UNAVAILABLE",
        "login succeeded but neither the redirect URL nor the Set-Cookie headers carried SESSDATA " +
          "(url=" + (String(body.data?.url ?? "").length > 0 ? "present" : "empty") +
          ", setCookie=" + setCookies.length + ")"
      );
    }
    return { state: "success", credential };
  }
  return { state: "waiting" };
}

/**
 * Read one cookie value out of a list of `Set-Cookie` header strings.
 * @param {string[]} setCookies - raw header values.
 * @param {string} name - cookie name.
 * @returns {string} the value, or an empty string.
 */
function cookieFromHeaders(setCookies, name) {
  for (const header of setCookies) {
    const [pair] = String(header).split(";");
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return "";
}

/**
 * Extract the login cookies, preferring the redirect URL and falling back to
 * the `Set-Cookie` headers.
 * @param {string} loginUrl - `data.url`, whose query string may hold the cookies.
 * @param {string} refreshToken - `data.refresh_token`.
 * @param {string[]} [setCookies] - `Set-Cookie` header values from the poll.
 * @returns {{sessdata: string, biliJct: string, dedeUserId: string, refreshToken: string, savedAt: string} | null}
 */
export function credentialFromLoginUrl(loginUrl, refreshToken = "", setCookies = []) {
  let params = new URLSearchParams();
  try {
    params = new URL(loginUrl).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const pick = (name) => {
    const fromUrl = params.get(name) ?? "";
    if (fromUrl.length > 0) return fromUrl;
    return cookieFromHeaders(setCookies, name);
  };

  const sessdata = pick("SESSDATA");
  if (sessdata.length === 0) return null;
  return {
    sessdata,
    biliJct: pick("bili_jct"),
    dedeUserId: pick("DedeUserID"),
    refreshToken,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Persist a credential next to the plugin's other state.
 * @param {object} config - plugin config.
 * @param {object} credential - from {@link pollLogin}.
 * @returns {Promise<string>} the file written.
 */
export async function saveCredential(config, credential) {
  const target = credentialFile(config);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(credential, null, 2), { encoding: "utf8", mode: 0o600 });
  return target;
}

/**
 * Read a stored credential.
 * @param {object} config - plugin config.
 * @returns {Promise<object | null>} the credential, or null when absent.
 */
export async function readCredential(config) {
  try {
    const raw = await readFile(credentialFile(config), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.sessdata !== "string" || parsed.sessdata.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Delete the stored credential.
 * @param {object} config - plugin config.
 * @returns {Promise<boolean>} whether a file was removed.
 */
export async function clearCredential(config) {
  try {
    await rm(credentialFile(config), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a stored credential against the live API.
 *
 * `nav` answers `-101` for an anonymous caller and `0` with a `mid` for a live
 * session, so it doubles as the cheapest expiry check. Refresh is deliberately
 * NOT attempted: `cookie/refresh` needs `refresh_token` + `csrf` + an RSA-OAEP
 * `correspondPath`, and a SESSDATA normally survives months. On `-101` the tool
 * asks the user to scan again.
 *
 * @param {object} config - plugin config.
 * @param {object} credential - credential to test.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<{ok: boolean, mid: number, name: string, reason?: string}>}
 */
export async function verifyCredential(config, credential, signal) {
  const timeout = AbortSignal.timeout(Number(config?.requestTimeoutMs ?? 20000));
  const parts = ["SESSDATA=" + credential.sessdata];
  if (credential.biliJct) parts.push("bili_jct=" + credential.biliJct);
  if (credential.dedeUserId) parts.push("DedeUserID=" + credential.dedeUserId);
  let body;
  try {
    const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Referer: "https://www.bilibili.com/",
        Cookie: parts.join("; "),
      },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    body = await response.json();
  } catch (error) {
    return { ok: false, mid: 0, name: "", reason: "network: " + (error instanceof Error ? error.message : String(error)) };
  }
  const code = Number(body?.code);
  if (code === 0 && Number(body?.data?.isLogin) === 1) {
    return { ok: true, mid: Number(body.data.mid ?? 0), name: String(body.data.uname ?? "") };
  }
  return { ok: false, mid: 0, name: "", reason: code === -101 ? "expired or invalid (账号未登录)" : "code " + code };
}
