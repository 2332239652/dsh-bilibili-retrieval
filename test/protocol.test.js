// Offline tests for the protocol layer. No network: every case is either pure
// or drives the client against a stubbed global fetch.
import assert from "node:assert/strict";
import test from "node:test";

import {
  BiliClient,
  BiliError,
  mixinKey,
  parseVideoRef,
  wbiSign,
} from "../lib/protocol.js";
import { durationSeconds, formatDuration, humanCount, plainText } from "../lib/tools.js";

const CONFIG = {
  anonMinIntervalMs: 0,
  anonBurst: 10,
  authMinIntervalMs: 0,
  authBurst: 5,
  authMaxPerSession: 20,
  cacheTtlMetaMs: 86400000,
  cacheTtlCommentsMs: 3600000,
  cacheTtlSpriteMs: 604800000,
  requestTimeoutMs: 5000,
  credentialPath: "",
};

/** Install a fetch stub for the duration of one test; returns the call log. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

/** Build a JSON Response the way bilibili answers. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

test("parseVideoRef accepts BV ids, av numbers and URLs", () => {
  assert.deepEqual(parseVideoRef("BV1ZRbe6eENh"), { bvid: "BV1ZRbe6eENh" });
  assert.deepEqual(parseVideoRef("av80433022"), { aid: 80433022 });
  assert.deepEqual(parseVideoRef("https://www.bilibili.com/video/BV1ZRbe6eENh?p=2"), {
    bvid: "BV1ZRbe6eENh",
  });
  assert.deepEqual(parseVideoRef("https://www.bilibili.com/video/av80433022"), { aid: 80433022 });
});

test("parseVideoRef rejects input with no video id", () => {
  assert.throws(() => parseVideoRef(""), (error) => error instanceof BiliError && error.code === "BILIBILI_BAD_ARGUMENT");
  assert.throws(() => parseVideoRef("not a video"), (error) => error.code === "BILIBILI_BAD_ARGUMENT");
});

test("mixinKey permutes the two WBI keys and truncates to 32 chars", () => {
  const raw = "7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45";
  const key = mixinKey(
    "https://i0.hdslb.com/bfs/wbi/" + raw.slice(0, 32) + ".png",
    "https://i0.hdslb.com/bfs/wbi/" + raw.slice(32) + ".png"
  );
  // The permutation table has 64 entries; bilibili takes only the first 32.
  assert.equal(key.length, 32);
  assert.equal(key, "ea1db124af3c7062474693fa704f4ff8");
});

test("wbiSign sorts parameters and appends wts then w_rid", () => {
  const signed = wbiSign({ b: "2", a: "1" }, "key", 1700000000);
  assert.match(signed, /^a=1&b=2&wts=1700000000&w_rid=[0-9a-f]{64}$/);
});

test("anonymousCookie must not recurse through requestJson", async () => {
  // Regression: routing the bootstrap through requestJson made cookieFor call
  // anonymousCookie call requestJson forever — a 72s stall in production.
  const stub = stubFetch(async (url) => {
    if (url.includes("/x/frontend/finger/spi")) {
      return jsonResponse({ code: 0, data: { b_3: "BUVID3", b_4: "BUVID4" } });
    }
    throw new Error("unexpected URL in bootstrap: " + url);
  });
  try {
    const client = new BiliClient({ config: CONFIG });
    const started = Date.now();
    const cookie = await client.anonymousCookie();
    assert.ok(Date.now() - started < 2000, "bootstrap must not stall");
    assert.match(cookie, /buvid3=BUVID3/);
    assert.match(cookie, /buvid4=BUVID4/);
    assert.equal(stub.calls.length, 1, "bootstrap must issue exactly one request");
    // Memoized: a second call must not hit the network again.
    await client.anonymousCookie();
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("wbiMixin tolerates nav answering -101 for an anonymous caller", async () => {
  // Regression: nav returns code -101 but still carries data.wbi_img.
  const raw = "7cd084941338484aae1ad9425b84077c4932caff0ff746eab6f01bf08b70ac45";
  const stub = stubFetch(async (url) => {
    if (url.includes("/x/frontend/finger/spi")) {
      return jsonResponse({ code: 0, data: { b_3: "b3", b_4: "b4" } });
    }
    if (url.includes("/x/web-interface/nav")) {
      return jsonResponse({
        code: -101,
        message: "账号未登录",
        data: {
          wbi_img: {
            img_url: "https://i0.hdslb.com/bfs/wbi/" + raw.slice(0, 32) + ".png",
            sub_url: "https://i0.hdslb.com/bfs/wbi/" + raw.slice(32) + ".png",
          },
        },
      });
    }
    throw new Error("unexpected URL: " + url);
  });
  try {
    const client = new BiliClient({ config: CONFIG });
    const key = await client.wbiMixin();
    assert.equal(key.length, 32);
  } finally {
    stub.restore();
  }
});

test("error codes map to stable BiliError codes", async () => {
  const cases = [
    [-101, "BILIBILI_LOGIN_REQUIRED"],
    [-352, "BILIBILI_RISK_CONTROL"],
    [-412, "BILIBILI_RISK_CONTROL"],
    [-403, "BILIBILI_FORBIDDEN"],
    [-404, "BILIBILI_NOT_FOUND"],
    [-9999, "BILIBILI_API_ERROR"],
  ];
  for (const [code, expected] of cases) {
    const stub = stubFetch(async () => jsonResponse({ code, message: "stub" }));
    try {
      const client = new BiliClient({ config: CONFIG });
      await assert.rejects(
        client.requestJson("anonymous", "https://api.bilibili.com/x/stub"),
        (error) => error instanceof BiliError && error.code === expected,
        `code ${code} should map to ${expected}`
      );
    } finally {
      stub.restore();
    }
  }
});

test("a BiliError carries its code in the message the model sees", () => {
  // The registry renders a thrown error as `Error: <message>`. A code kept only
  // in a property never reaches the model, which is how the AI-summary refusal
  // surfaced as a bare "访问权限不足" with no route forward.
  const error = new BiliError("BILIBILI_SUMMARY_FORBIDDEN", "use bili_transcript instead");
  assert.equal(error.message, "BILIBILI_SUMMARY_FORBIDDEN: use bili_transcript instead");
  assert.equal(error.code, "BILIBILI_SUMMARY_FORBIDDEN");
  assert.ok(error.message.startsWith(error.code), "the code must lead the message");
});

test("an HTML interstitial becomes BILIBILI_RISK_CONTROL, never leaks HTML", async () => {
  const stub = stubFetch(
    async () => new Response("<!DOCTYPE html><html>blocked</html>", { status: 412, headers: { "content-type": "text/html" } })
  );
  try {
    const client = new BiliClient({ config: CONFIG });
    await assert.rejects(
      client.requestJson("anonymous", "https://api.bilibili.com/x/stub"),
      (error) => error.code === "BILIBILI_RISK_CONTROL" && !error.message.includes("DOCTYPE")
    );
  } finally {
    stub.restore();
  }
});

test("cache serves a repeated call without a second request", async () => {
  let hits = 0;
  const stub = stubFetch(async (url) => {
    if (url.includes("/x/frontend/finger/spi")) {
      return jsonResponse({ code: 0, data: { b_3: "b3", b_4: "b4" } });
    }
    hits += 1;
    return jsonResponse({ code: 0, data: { ok: true } });
  });
  try {
    const client = new BiliClient({ config: CONFIG });
    const url = "https://api.bilibili.com/x/stub";
    await client.requestJson("anonymous", url, { cacheTtlMs: 60000 });
    await client.requestJson("anonymous", url, { cacheTtlMs: 60000 });
    assert.equal(hits, 1);
  } finally {
    stub.restore();
  }
});

test("concurrent identical calls are single-flighted", async () => {
  let hits = 0;
  const stub = stubFetch(async (url) => {
    if (url.includes("/x/frontend/finger/spi")) {
      return jsonResponse({ code: 0, data: { b_3: "b3", b_4: "b4" } });
    }
    hits += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse({ code: 0, data: { ok: true } });
  });
  try {
    const client = new BiliClient({ config: CONFIG });
    const url = "https://api.bilibili.com/x/stub";
    await Promise.all([
      client.requestJson("anonymous", url),
      client.requestJson("anonymous", url),
      client.requestJson("anonymous", url),
    ]);
    assert.equal(hits, 1, "three concurrent calls must share one request");
  } finally {
    stub.restore();
  }
});

test("the authenticated channel enforces its per-session cap", async () => {
  const stub = stubFetch(async (url) => {
    if (url.includes("/x/frontend/finger/spi")) {
      return jsonResponse({ code: 0, data: { b_3: "b3", b_4: "b4" } });
    }
    return jsonResponse({ code: 0, data: { ok: true } });
  });
  try {
    const client = new BiliClient({ config: { ...CONFIG, authMaxPerSession: 2 } });
    client.credential = { sessdata: "S", biliJct: "J", dedeUserId: "1" };
    const url = "https://api.bilibili.com/x/stub";
    await client.requestJson("auth", url + "?a=1");
    await client.requestJson("auth", url + "?a=2");
    await assert.rejects(
      client.requestJson("auth", url + "?a=3"),
      (error) => error.code === "BILIBILI_AUTH_BUDGET_EXHAUSTED"
    );
  } finally {
    stub.restore();
  }
});

test("the credential cookie never reaches a non-bilibili origin", async () => {
  const stub = stubFetch(async (url) => {
    if (url.includes("/x/frontend/finger/spi")) {
      return jsonResponse({ code: 0, data: { b_3: "b3", b_4: "b4" } });
    }
    return jsonResponse({ code: 0, data: { ok: true } });
  });
  try {
    const client = new BiliClient({ config: CONFIG });
    client.credential = { sessdata: "SECRET", biliJct: "J", dedeUserId: "1" };
    await client.requestJson("auth", "https://evil.example.com/x");
    const headers = stub.calls.at(-1).init.headers;
    assert.equal(headers.Cookie, undefined, "the login cookie must not follow a foreign origin");
  } finally {
    stub.restore();
  }
});

test("plainText strips highlight markup and entities", () => {
  assert.equal(plainText('<em class="keyword">Python</em> 教程 &amp; 资料'), "Python 教程 & 资料");
  assert.equal(plainText(undefined), "");
});

test("humanCount and duration helpers", () => {
  assert.equal(humanCount(292687), "29.3万");
  assert.equal(humanCount(150000000), "1.5亿");
  assert.equal(humanCount(0), "0");
  assert.equal(durationSeconds("2:22:43"), 8563);
  assert.equal(durationSeconds("4:35"), 275);
  assert.equal(durationSeconds(88), 88);
  assert.equal(formatDuration(8563), "2:22:43");
  assert.equal(formatDuration(275), "4:35");
});
