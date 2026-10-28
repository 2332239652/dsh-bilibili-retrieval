// Offline tests for the login, QR and subtitle layers.
import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialFromLoginUrl,
  QR_STATE,
} from "../lib/login.js";
import { encode, toPng } from "../lib/qr.js";
import { decodePngHeader } from "./png-helper.js";

test("credential comes from Set-Cookie headers when the URL carries none", () => {
  // Regression: the first real scan returned a crossDomain URL whose query held
  // only ticket/gourl/first_domain. Reading the URL alone lost a valid login.
  const url = "https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=abc&gourl=x&first_domain=y";
  const setCookies = [
    "SESSDATA=sess_value_123; Path=/; Domain=.bilibili.com; HttpOnly",
    "bili_jct=jct_value; Path=/; Domain=.bilibili.com",
    "DedeUserID=42; Path=/; Domain=.bilibili.com",
    "DedeUserID__ckMd5=md5; Path=/; Domain=.bilibili.com",
    "sid=sidval; Path=/; Domain=.bilibili.com",
  ];
  const credential = credentialFromLoginUrl(url, "refresh", setCookies);
  assert.notEqual(credential, null);
  assert.equal(credential.sessdata, "sess_value_123");
  assert.equal(credential.biliJct, "jct_value");
  assert.equal(credential.dedeUserId, "42");
  assert.equal(credential.refreshToken, "refresh");
});

test("credential prefers the URL when both sources carry a cookie", () => {
  const url = "https://passport.bilibili.com/x/passport-login/web/crossDomain?SESSDATA=from_url&DedeUserID=7";
  const credential = credentialFromLoginUrl(url, "", ["SESSDATA=from_header; Path=/"]);
  assert.equal(credential.sessdata, "from_url");
  assert.equal(credential.dedeUserId, "7");
});

test("credential is null when no source carries SESSDATA", () => {
  assert.equal(credentialFromLoginUrl("https://x/y?ticket=1", "", ["bili_jct=only; Path=/"]), null);
  assert.equal(credentialFromLoginUrl("not a url", "", []), null);
});

test("QR poll states are the documented values", () => {
  assert.equal(QR_STATE.SUCCESS, 0);
  assert.equal(QR_STATE.EXPIRED, 86038);
  assert.equal(QR_STATE.SCANNED, 86090);
  assert.equal(QR_STATE.WAITING, 86101);
});

test("QR encoder picks the smallest version that fits", () => {
  assert.equal(encode("a".repeat(10)).version, 1);
  assert.equal(encode("a".repeat(40)).version, 3);
  assert.equal(encode("a".repeat(200)).version, 10);
  // 213 bytes is the version-10 byte capacity at level M.
  assert.throws(() => encode("a".repeat(300)), /exceeds the largest supported QR version/);
});

test("QR matrix has the structural features a decoder needs", () => {
  const matrix = encode("https://example.com/x");
  const { size, modules } = matrix;
  assert.equal(size, matrix.version * 4 + 17);

  // Three finder patterns: a dark 7x7 ring with a dark 3x3 core.
  const finderAt = (row, col) => {
    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < 7; c += 1) {
        const edge = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const expected = edge || core ? 1 : 0;
        if (modules[row + r][col + c] !== expected) return false;
      }
    }
    return true;
  };
  assert.ok(finderAt(0, 0), "top-left finder");
  assert.ok(finderAt(0, size - 7), "top-right finder");
  assert.ok(finderAt(size - 7, 0), "bottom-left finder");

  // The dark module is always set.
  assert.equal(modules[size - 8][8], 1);

  // Timing patterns alternate along row/column 6.
  for (let i = 8; i <= size - 9; i += 1) {
    assert.equal(modules[6][i], i % 2 === 0 ? 1 : 0, `timing row at ${i}`);
  }
});

test("format information decodes back to the chosen mask and level M", () => {
  for (const mask of [0, 3, 7]) {
    const { size, modules } = encode("https://example.com/y", { mask });
    const at = (r, c) => modules[r][c];
    let bits = 0;
    for (let i = 0; i < 6; i += 1) bits |= at(i, 8) << i;
    bits |= at(7, 8) << 6;
    bits |= at(8, 8) << 7;
    bits |= at(8, 7) << 8;
    for (let i = 9; i < 15; i += 1) bits |= at(8, 14 - i) << i;
    const unmasked = bits ^ 0x5412;
    assert.equal((unmasked >> 10) & 0b111, mask, `mask ${mask} must survive the round trip`);
    assert.equal((unmasked >> 13) & 0b11, 0b00, "level M is encoded as 00");
    // The second copy must agree.
    let copy = 0;
    for (let i = 0; i < 8; i += 1) copy |= at(8, size - 1 - i) << i;
    for (let i = 8; i < 15; i += 1) copy |= at(size - 15 + i, 8) << i;
    assert.equal(copy, bits, "both format copies must match");
  }
});

test("toPng emits a valid grayscale PNG of the expected size", async () => {
  const matrix = encode("https://example.com/z");
  const png = await toPng(matrix, { scale: 4, quietZone: 4 });
  const header = decodePngHeader(png);
  assert.equal(header.signature, true);
  assert.equal(header.width, (matrix.size + 8) * 4);
  assert.equal(header.height, header.width);
  assert.equal(header.bitDepth, 8);
  assert.equal(header.colorType, 0, "grayscale keeps the encoder trivial");
  assert.ok(png.length > 100);
});
