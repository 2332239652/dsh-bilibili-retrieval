/**
 * L0 protocol layer: the shared machinery every bilibili tool goes through.
 *
 * Three rules, each earned from a measurement rather than a guess:
 *
 *  1. CHANNEL SPLIT. Search/comments/frames run on the anonymous identity with
 *     a wide budget. Subtitles / AI summary / uploader listings run on the
 *     scanned-in identity with a tight budget. Rationale: risk control exists
 *     at IP level AND account level. IP throttling just slows us down; account
 *     flagging follows the real user around. High-frequency work therefore
 *     never touches the account.
 *
 *  2. CACHE FIRST. `all/v2` survives a burst, `wbi/search/type` answers with a
 *     `v_voucher` challenge on request 7, and the unsigned `search/type` gets
 *     HTTP 412 on request 2. Every avoidable request is a request not spent.
 *
 *  3. STRUCTURED FAILURES. Bilibili signals problems as HTTP 200 with a
 *     non-zero `code`, or as an HTML interstitial with a non-200 status. Both
 *     are normalized into `BiliError` with a stable code, so tools fail
 *     predictably instead of leaking HTML into a model's context.
 */

import { createHmac } from "node:crypto";

/** Desktop UA; bilibili rejects obviously-scripted clients. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Origins the cookie may be sent to. Anything else gets a cookie-free request. */
const CREDENTIAL_ORIGINS = new Set([
  "https://api.bilibili.com",
  "https://passport.bilibili.com",
  "https://api.live.bilibili.com",
]);

/** Video id shapes this plugin accepts. */
const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const AID_PATTERN = /^av(\d+)$/i;

/**
 * A failure with a stable, model-facing code.
 * Tools report these instead of raw exceptions so the model can route on them.
 *
 * The code is prefixed into `message` on purpose: the tool registry renders a
 * thrown error as `Error: <message>`, so a code kept only in a property would
 * never reach the model.
 */
export class BiliError extends Error {
  /**
   * @param {string} code - stable identifier, e.g. `BILIBILI_RISK_CONTROL`.
   * @param {string} message - human-readable detail.
   */
  constructor(code, message) {
    super(code + ": " + message);
    this.name = "BiliError";
    this.code = code;
  }
}

/**
 * Normalize a user-supplied video reference.
 * @param {unknown} input - bvid, av number, or a bilibili video URL.
 * @returns {{bvid: string}} the canonical id.
 */
export function parseVideoRef(input) {
  const raw = String(input ?? "").trim();
  if (raw.length === 0) throw new BiliError("BILIBILI_BAD_ARGUMENT", "a video id or url is required");
  if (BVID_PATTERN.test(raw)) return { bvid: raw };
  const aidMatch = AID_PATTERN.exec(raw);
  if (aidMatch !== null) return { aid: Number(aidMatch[1]) };
  const urlMatch = /(BV[0-9A-Za-z]{10})/.exec(raw);
  if (urlMatch !== null) return { bvid: urlMatch[1] };
  const avInUrl = /\/av(\d+)/i.exec(raw);
  if (avInUrl !== null) return { aid: Number(avInUrl[1]) };
  throw new BiliError("BILIBILI_BAD_ARGUMENT", "could not read a video id from " + JSON.stringify(raw.slice(0, 80)));
}

/**
 * A token bucket. One instance per channel, so a burst of search calls can
 * never consume the budget reserved for subtitles.
 */
class TokenBucket {
  /**
   * @param {number} minIntervalMs - minimum spacing between request starts.
   * @param {number} burst - maximum accumulated tokens.
   */
  constructor(minIntervalMs, burst) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.queue = Promise.resolve();
  }

  /** @returns {void} */
  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    if (this.minIntervalMs === 0) {
      this.tokens = this.capacity;
      return;
    }
    this.tokens = Math.min(this.capacity, this.tokens + elapsed / this.minIntervalMs);
  }

  /**
   * Wait until a token is available, then consume one. Serialized so
   * concurrent callers queue instead of all reading the same token.
   * @returns {Promise<void>}
   */
  take() {
    const run = this.queue.then(async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const need = (1 - this.tokens) * this.minIntervalMs;
        await new Promise((resolve) => setTimeout(resolve, Math.max(25, Math.ceil(need))));
      }
    });
    // Keep the chain alive even if one waiter rejects.
    this.queue = run.catch(() => {});
    return run;
  }
}

/**
 * A bounded in-process cache with per-entry TTL.
 * Keys are derived from the channel, path and query, so a different page or a
 * different channel never collides.
 */
class TtlCache {
  /** @param {number} maxEntries - hard cap; oldest entries are evicted first. */
  constructor(maxEntries = 500) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  /**
   * @param {string} key - cache key.
   * @returns {unknown | undefined} the cached value when still fresh.
   */
  get(key) {
    const hit = this.map.get(key);
    if (hit === undefined) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency for a simple LRU-ish eviction order.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  /**
   * @param {string} key - cache key.
   * @param {unknown} value - value to store.
   * @param {number} ttlMs - lifetime in milliseconds.
   * @returns {void}
   */
  set(key, value, ttlMs) {
    if (ttlMs <= 0) return;
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** @returns {void} */
  clear() {
    this.map.clear();
  }
}

/** WBI mixin-key permutation table, fixed by bilibili's web client. */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/**
 * Derive the 32-char mixin key from the two WBI image keys.
 *
 * The permutation table has 64 entries, so it yields 64 characters; bilibili
 * takes only the first 32 of them. Dropping that truncation is a silent bug —
 * the signature it produces is simply wrong.
 *
 * @param {string} imgUrl - `wbi_img.img_url`.
 * @param {string} subUrl - `wbi_img.sub_url`.
 * @returns {string} the 32-character mixin key.
 */
export function mixinKey(imgUrl, subUrl) {
  const pick = (url) => String(url ?? "").split("/").pop().replace(/\.\w+$/, "");
  const raw = pick(imgUrl) + pick(subUrl);
  let out = "";
  for (const index of MIXIN_KEY_ENC_TAB) out += raw[index] ?? "";
  return out.slice(0, 32);
}

/**
 * Sign query parameters for a WBI endpoint.
 *
 * Measured caveat (2026-10): the endpoint currently accepts a correct HMAC, an
 * all-zero `w_rid`, a random `w_rid`, and no `w_rid` at all — all four return
 * the same results. The real gate is the `buvid` cookie plus request rate, not
 * the signature. This is implemented correctly anyway so the client survives a
 * server-side tightening, but callers must not treat signing as the thing that
 * makes a request succeed.
 *
 * @param {Record<string, string>} params - endpoint parameters.
 * @param {string} key - mixin key from {@link mixinKey}.
 * @param {number} [nowSeconds] - injectable clock for tests.
 * @returns {string} the signed query string, including `w_rid`.
 */
export function wbiSign(params, key, nowSeconds = Math.floor(Date.now() / 1000)) {
  const entries = Object.entries(params)
    .map(([k, v]) => [k, String(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  entries.push(["wts", String(nowSeconds)]);
  const query = entries
    .map(
      ([k, v]) =>
        encodeURIComponent(k) +
        "=" +
        encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    )
    .join("&");
  const rid = createHmac("sha256", key).update(query).digest("hex");
  return query + "&w_rid=" + rid;
}

/**
 * Structural parse of one bilibili envelope.
 * @param {unknown} body - parsed JSON body.
 * @param {number} status - HTTP status.
 * @returns {unknown} `body.data`.
 */
function unwrap(body, status) {
  if (body === null || typeof body !== "object" || !Object.hasOwn(body, "code")) {
    throw new BiliError("BILIBILI_BAD_RESPONSE", "response was not a bilibili envelope (HTTP " + status + ")");
  }
  const code = Number(body.code);
  const message = String(body.message ?? "");
  if (code === 0) return body.data;
  switch (code) {
    case -101:
      throw new BiliError("BILIBILI_LOGIN_REQUIRED", "this endpoint needs a logged-in account (" + message + ")");
    case -352:
      throw new BiliError("BILIBILI_RISK_CONTROL", "risk control rejected the request; wait and retry (" + message + ")");
    case -412:
      throw new BiliError("BILIBILI_RISK_CONTROL", "request blocked by risk control; wait before retrying (" + message + ")");
    case -403:
      throw new BiliError("BILIBILI_FORBIDDEN", "bilibili refused access to this resource (" + message + ")");
    case -404:
      throw new BiliError("BILIBILI_NOT_FOUND", "the video does not exist or was removed (" + message + ")");
    default:
      throw new BiliError("BILIBILI_API_ERROR", "bilibili error " + code + ": " + message);
  }
}

/**
 * The single client every tool shares.
 *
 * It owns three things the tools must not each reinvent: which identity a
 * request uses, how many requests that identity may spend, and what a failure
 * means.
 */
export class BiliClient {
  /**
   * @param {object} options - resolved plugin config.
   * @param {object} options.config - row config (rate limits, TTLs, timeout).
   * @param {{sessdata: string, biliJct: string, dedeUserId: string} | null} [options.credential] - scanned login.
   */
  constructor({ config, credential = null }) {
    this.config = config;
    this.credential = credential;
    this.anonBucket = new TokenBucket(config.anonMinIntervalMs, config.anonBurst);
    this.authBucket = new TokenBucket(config.authMinIntervalMs, config.authBurst);
    this.cache = new TtlCache(600);
    this.anonCookies = null;
    this.wbiKeys = null;
    this.authCallsThisSession = 0;
    this.inflight = new Map();
  }

  /** @returns {boolean} whether a scanned login is available. */
  get hasCredential() {
    return this.credential !== null && String(this.credential?.sessdata ?? "").length > 0;
  }

  /**
   * Bootstrap the anonymous identity cookies. Bilibili hands out `buvid3` /
   * `buvid4` without a login; carrying them makes the anonymous channel look
   * like a first-visit browser instead of a cold script.
   *
   * Deliberately NOT routed through {@link requestJson}: that method needs a
   * Cookie header, so going through it would recurse into this method forever.
   * This is the one place that speaks to bilibili without a cookie.
   *
   * @param {AbortSignal} [signal] - cooperative cancellation.
   * @returns {Promise<string>} a Cookie header value.
   */
  async anonymousCookie(signal) {
    if (this.anonCookies !== null) return this.anonCookies;
    const fallback = "b_nut=" + Math.floor(Date.now() / 1000);
    try {
      const timeout = AbortSignal.timeout(Number(this.config.requestTimeoutMs ?? 20000));
      const response = await fetch("https://api.bilibili.com/x/frontend/finger/spi", {
        headers: { "User-Agent": USER_AGENT, Referer: "https://www.bilibili.com/" },
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      });
      const body = await response.json();
      const data = body?.data;
      const parts = [];
      if (typeof data?.b_3 === "string") parts.push("buvid3=" + data.b_3);
      if (typeof data?.b_4 === "string") parts.push("buvid4=" + data.b_4);
      parts.push(fallback);
      this.anonCookies = parts.join("; ");
    } catch {
      // A cold identity still works for search and metadata.
      this.anonCookies = fallback;
    }
    return this.anonCookies;
  }

  /**
   * Fetch (and memoize) the WBI signing keys.
   *
   * `x/web-interface/nav` answers `code: -101` ("账号未登录") for an anonymous
   * caller, yet still carries `data.wbi_img`. Treating that code as a failure
   * would discard usable keys, so this reads the payload directly instead of
   * going through the shared error mapping.
   *
   * Measured caveat: the WBI endpoints currently accept a correct signature, an
   * all-zero `w_rid`, a random `w_rid`, and no `w_rid` at all. Signing is
   * implemented for correctness, not because it gates access.
   *
   * @param {AbortSignal} [signal] - cooperative cancellation.
   * @returns {Promise<string>} the mixin key.
   */
  async wbiMixin(signal) {
    if (this.wbiKeys !== null) return this.wbiKeys;
    const cookie = await this.anonymousCookie(signal);
    const timeout = AbortSignal.timeout(Number(this.config.requestTimeoutMs ?? 20000));
    const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        Referer: "https://www.bilibili.com/",
        Cookie: cookie,
      },
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
    const body = await response.json();
    const img = body?.data?.wbi_img?.img_url;
    const sub = body?.data?.wbi_img?.sub_url;
    if (typeof img !== "string" || typeof sub !== "string") {
      throw new BiliError("BILIBILI_WBI_KEYS_UNAVAILABLE", "could not read wbi keys from the nav payload");
    }
    this.wbiKeys = mixinKey(img, sub);
    return this.wbiKeys;
  }

  /**
   * Build the Cookie header for a channel, then send.
   * @param {"anonymous" | "auth"} channel - which identity to spend.
   * @returns {Promise<string>} the Cookie header (possibly empty).
   */
  async cookieFor(channel) {
    if (channel === "auth" && this.hasCredential) {
      const parts = ["SESSDATA=" + this.credential.sessdata];
      if (this.credential.biliJct) parts.push("bili_jct=" + this.credential.biliJct);
      if (this.credential.dedeUserId) parts.push("DedeUserID=" + this.credential.dedeUserId);
      return parts.join("; ");
    }
    return this.anonymousCookie();
  }

  /**
   * Perform one GET and return the unwrapped `data`.
   *
   * @param {"anonymous" | "auth"} channel - budget and identity to use.
   * @param {string} url - absolute https URL.
   * @param {object} [options] - per-call options.
   * @param {number} [options.cacheTtlMs] - 0 disables caching for this call.
   * @param {boolean} [options.skipBucket] - bypass rate limiting (bootstrap only).
   * @param {AbortSignal} [options.signal] - cooperative cancellation.
   * @returns {Promise<any>} unwrapped `data`.
   */
  async requestJson(channel, url, options = {}) {
    const ttl = Number(options.cacheTtlMs ?? 0);
    const key = channel + " " + url;
    if (ttl > 0) {
      const hit = this.cache.get(key);
      if (hit !== undefined) return hit;
    }
    // Single-flight: concurrent identical calls share one request.
    const pending = this.inflight.get(key);
    if (pending !== undefined) return pending;

    const run = (async () => {
      if (options.skipBucket !== true) {
        const origin = new URL(url).origin;
        const bucket = channel === "auth" ? this.authBucket : this.anonBucket;
        await bucket.take();
        if (channel === "auth" && CREDENTIAL_ORIGINS.has(origin)) {
          this.authCallsThisSession += 1;
          const cap = Number(this.config.authMaxPerSession ?? 0);
          if (cap > 0 && this.authCallsThisSession > cap) {
            throw new BiliError(
              "BILIBILI_AUTH_BUDGET_EXHAUSTED",
              "session cap of " + cap + " authenticated requests reached; anonymous tools still work"
            );
          }
        }
      }

      const origin = new URL(url).origin;
      const usesCredential = channel === "auth" && this.hasCredential && CREDENTIAL_ORIGINS.has(origin);
      const cookie = await this.cookieFor(channel);
      const timeout = AbortSignal.timeout(Number(this.config.requestTimeoutMs ?? 20000));
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
          Referer: "https://www.bilibili.com/",
          ...(cookie.length > 0 && (usesCredential || origin === "https://api.bilibili.com") ? { Cookie: cookie } : {}),
        },
        redirect: "follow",
        signal,
      });

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("json")) {
        // Risk control answers with an HTML interstitial, including HTTP 412.
        if (response.status === 412) {
          throw new BiliError("BILIBILI_RISK_CONTROL", "HTTP 412 risk-control interstitial; back off before retrying");
        }
        throw new BiliError("BILIBILI_BAD_RESPONSE", "non-JSON response (HTTP " + response.status + ")");
      }

      const body = await response.json();
      const data = unwrap(body, response.status);
      if (ttl > 0) this.cache.set(key, data, ttl);
      return data;
    })();

    this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  /**
   * Call a WBI-signed endpoint.
   * @param {"anonymous" | "auth"} channel - budget and identity to use.
   * @param {string} path - path below `api.bilibili.com`.
   * @param {Record<string, string>} params - endpoint parameters.
   * @param {object} [options] - cache / cancellation options.
   * @returns {Promise<any>} unwrapped `data`.
   */
  async requestWbi(channel, path, params, options = {}) {
    const key = await this.wbiMixin(options.signal);
    const query = wbiSign(params, key);
    return this.requestJson(channel, "https://api.bilibili.com" + path + "?" + query, options);
  }

  /** @returns {void} drop memoized state after a login change. */
  resetSession() {
    this.cache.clear();
    this.authCallsThisSession = 0;
  }
}
