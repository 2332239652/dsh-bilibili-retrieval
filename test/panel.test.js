// Tests for the control-panel HTTP surface.
//
// These exercise the route handler directly with fake req/res objects, so no
// server, network, or real credential is involved. What matters here is the
// security boundary (same-origin, no credential leak) and the route contract.
import assert from "node:assert/strict";
import test from "node:test";

import { API_PREFIX, mountControlPanel } from "../lib/panel.js";

/** Minimal fake response that records what was written. */
function fakeRes() {
  const out = { status: 0, headers: {}, body: "" };
  return {
    out,
    writeHead(code, headers) {
      out.status = code;
      out.headers = headers ?? {};
    },
    end(chunk) {
      out.body = chunk === undefined ? "" : String(chunk);
    },
    json() {
      return out.body.length === 0 ? null : JSON.parse(out.body);
    },
  };
}

/** Minimal fake request. */
function fakeReq({ method = "GET", url = API_PREFIX + "/status", headers = {}, body = null } = {}) {
  const base = { method, url, headers: { host: "127.0.0.1:5000", ...headers } };
  if (body === null) {
    return Object.assign(base, { async *[Symbol.asyncIterator]() {} });
  }
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return Object.assign(base, {
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  });
}

/** Build a mount with stub collaborators and return the handler. */
function mount(overrides = {}) {
  let handler = null;
  const ctx = {
    webServer: {
      register(options) {
        handler = options.handler;
        return () => {};
      },
    },
  };

  const config = {
    anonMinIntervalMs: 2000,
    anonBurst: 5,
    authMinIntervalMs: 3000,
    authBurst: 2,
    authMaxPerSession: 20,
    requestTimeoutMs: 20000,
    framesMaxFiles: 12,
    framesMaxBytes: 24 * 1024 * 1024,
    version: "0.2.0",
  };

  const calls = { save: 0, clear: 0, reset: 0, patch: null };

  mountControlPanel(ctx, {
    config: () => ({ ...config }),
    client: { resetSession: () => { calls.reset += 1; } },
    login: {
      createLoginQr: async () => ({
        qrcodeKey: "KEY123",
        url: "https://account.bilibili.com/h5/account-scan?qrcode_key=KEY123",
        png: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      }),
      pollLogin: async () => ({ state: "waiting" }),
      readCredential: async () => overrides.credential ?? null,
      clearCredential: async () => { calls.clear += 1; },
      verifyCredential: async () => ({ ok: true, mid: 42, name: "tester" }),
      saveCredential: async () => { calls.save += 1; },
    },
    frames: {
      frameCacheReport: async () => overrides.cacheRows ?? [],
      clearFrames: async () => ({ removed: 2, freedBytes: 4096 }),
    },
    applyConfig: (patch) => {
      calls.patch = patch;
      Object.assign(config, patch);
      return { ...config };
    },
  });

  assert.notEqual(handler, null, "the panel must register a route");
  return { handler, calls, config };
}

test("status reports channels and never leaks the credential", async () => {
  const { handler } = mount({
    credential: { sessdata: "SECRET_SESSDATA", biliJct: "JCT", dedeUserId: "42", savedAt: "2026-01-01T00:00:00Z" },
  });
  const res = fakeRes();
  await handler(fakeReq(), res);

  assert.equal(res.out.status, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.account.valid, true);
  assert.equal(body.account.mid, 42);

  // The whole point: no secret material in the response.
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("SECRET_SESSDATA"), "SESSDATA must never leave the host");
  assert.ok(!serialized.includes("JCT"), "bili_jct must never leave the host");
});

test("a cross-origin request is refused before any work happens", async () => {
  const { handler, calls } = mount();
  const res = fakeRes();
  await handler(
    fakeReq({ method: "POST", url: API_PREFIX + "/logout", headers: { origin: "https://evil.example" } }),
    res
  );
  assert.equal(res.out.status, 403);
  assert.equal(calls.clear, 0, "the handler must not run for a foreign origin");
});

test("a non-loopback host is refused", async () => {
  const { handler } = mount();
  const res = fakeRes();
  await handler(fakeReq({ headers: { host: "192.168.1.9:5000" } }), res);
  assert.equal(res.out.status, 403);
});

test("a same-origin request is allowed", async () => {
  const { handler } = mount();
  const res = fakeRes();
  await handler(
    fakeReq({ headers: { host: "127.0.0.1:5000", origin: "http://127.0.0.1:5000" } }),
    res
  );
  assert.equal(res.out.status, 200);
});

test("minting a QR returns an inline data URL", async () => {
  // The browser cannot read a file path the host wrote, so the image has to
  // travel as a data URL. This is what makes "QR shown directly" possible.
  const { handler } = mount();
  const res = fakeRes();
  await handler(fakeReq({ method: "POST", url: API_PREFIX + "/qr" }), res);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.ok(body.qr.dataUrl.startsWith("data:image/png;base64,"), "must be a data URL");
  assert.equal(body.qr.state, "waiting");
  assert.ok(body.qr.url.includes("qrcode_key="));
});

test("polling a QR reports waiting, and status carries the pending code", async () => {
  const { handler } = mount();
  await handler(fakeReq({ method: "POST", url: API_PREFIX + "/qr" }), fakeRes());

  const res = fakeRes();
  await handler(fakeReq({ method: "GET", url: API_PREFIX + "/qr" }), res);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.qr.state, "waiting");

  const statusRes = fakeRes();
  await handler(fakeReq({ url: API_PREFIX + "/status" }), statusRes);
  assert.equal(statusRes.json().pending.key, "KEY123", "a refresh must not lose the pending QR");
});

test("logout clears the credential and resets the session cap", async () => {
  const { handler, calls } = mount();
  const res = fakeRes();
  await handler(fakeReq({ method: "POST", url: API_PREFIX + "/logout" }), res);
  assert.equal(res.out.status, 200);
  assert.equal(calls.clear, 1);
  assert.equal(calls.reset, 1, "a fresh logout must drop the auth budget");
});

test("cache clear reports what it freed", async () => {
  const { handler } = mount({ cacheRows: [{ dir: "/tmp/x", files: 2, bytes: 4096 }] });
  const res = fakeRes();
  await handler(fakeReq({ method: "POST", url: API_PREFIX + "/cache", body: { action: "clear" } }), res);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.removed, 2);
  assert.equal(body.freedBytes, 4096);
});

test("config POST whitelists numeric keys and rejects junk", async () => {
  const { handler, calls } = mount();
  const res = fakeRes();
  await handler(
    fakeReq({
      method: "POST",
      url: API_PREFIX + "/config",
      body: { anonBurst: 9, credentialPath: "/etc/passwd", evil: 1 },
    }),
    res
  );
  const body = res.json();
  assert.equal(body.ok, true);
  assert.deepEqual(calls.patch, { anonBurst: 9 }, "only known numeric keys may pass");

  const bad = fakeRes();
  await handler(fakeReq({ method: "POST", url: API_PREFIX + "/config", body: { nope: 1 } }), bad);
  assert.equal(bad.out.status, 400);
});

test("an unknown route answers 404 instead of throwing", async () => {
  const { handler } = mount();
  const res = fakeRes();
  await handler(fakeReq({ url: API_PREFIX + "/nope" }), res);
  assert.equal(res.out.status, 404);
  assert.equal(res.json().ok, false);
});

test("cache accounting sums every directory", async () => {
  const { handler } = mount({
    cacheRows: [
      { dir: "/a", files: 2, bytes: 1000 },
      { dir: "/b", files: 3, bytes: 2000 },
    ],
  });
  const res = fakeRes();
  await handler(fakeReq({ url: API_PREFIX + "/status" }), res);
  const cache = res.json().cache;
  assert.equal(cache.files, 5);
  assert.equal(cache.bytes, 3000);
  assert.equal(cache.dirs.length, 2);
});
