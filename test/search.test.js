// Offline tests for search noise filtering and comment link detection.
import assert from "node:assert/strict";
import test from "node:test";

import { matchScore, queryTokens } from "../lib/tools.js";

test("queryTokens keeps whole latin words and CJK runs", () => {
  // Longest first: "k8s" (3) before "入门" (2).
  assert.deepEqual(queryTokens("k8s 入门"), ["k8s", "入门"]);
  assert.deepEqual(queryTokens("Python 异步"), ["python", "异步"]);
  // Versions and accents must not be split apart.
  assert.deepEqual(queryTokens("C++ 教程"), ["c++", "教程"]);
  // A trailing dot is punctuation, but an inner one is part of the name.
  assert.deepEqual(queryTokens("node.js 入门"), ["node.js", "入门"]);
  assert.deepEqual(queryTokens("node.js."), ["node.js"]);
  // Single characters are too noisy to score on.
  assert.deepEqual(queryTokens("a"), []);
  assert.deepEqual(queryTokens(""), []);
});

test("queryTokens orders longest first so specific tokens win", () => {
  const tokens = queryTokens("kubernetes k8s");
  assert.equal(tokens[0], "kubernetes");
});

test("matchScore counts matched tokens", () => {
  const tokens = queryTokens("k8s 入门");
  assert.equal(matchScore("kubernetes一小时轻松入门".toLowerCase(), tokens), 1);
  assert.equal(matchScore("k8s 从入门到精通".toLowerCase(), tokens), 2);
  assert.equal(matchScore("火炬之光k8小时500火".toLowerCase(), tokens), 0);
});

test("the torchlight false positive is filtered", () => {
  // Regression: searching "k8s 入门" returned "火炬之光s14无需宠物k8小时500火"
  // because bilibili matched the fragment "k8" inside "k8小时". A subagent
  // reported having to hand-filter every result set.
  const tokens = queryTokens("k8s 入门");
  const noise = "火炬之光s14无需宠物k8小时500火 赛季玩法如何提高收益".toLowerCase();
  assert.equal(matchScore(noise, tokens), 0, "the torchlight video must score zero");

  const real = "kubernetes一小时轻松入门".toLowerCase();
  assert.ok(matchScore(real, tokens) > 0, "the real k8s tutorial must survive");
});

test("the Sky Hooks false positive is filtered", () => {
  // Regression: searching "react hooks" returned a jazz track "Sky Hooks".
  // "hooks" IS a whole word there, so word boundaries alone do not save it —
  // what saves it is requiring every latin token, and "react" is absent.
  const tokens = queryTokens("react hooks");
  const noise = "来首舒服惬意的Jazz HipHop！Lil Dicky《Sky Hooks》".toLowerCase();
  assert.equal(matchScore(noise, tokens), 1, "it matches hooks but not react");
  assert.ok(matchScore(noise, tokens) < tokens.length, "an all-latin query requires every token");
  const real = "14分钟了解所有 react hooks".toLowerCase();
  assert.equal(matchScore(real, tokens), 2);
});

test("a Chinese query tolerates the alias gap", () => {
  // The single best "k8s 入门" tutorial says "Kubernetes…入门" and never "k8s".
  // Requiring every token there would drop the best result, so a CJK query only
  // requires one match.
  const tokens = queryTokens("k8s 入门");
  const best = "kubernetes一小时轻松入门".toLowerCase();
  assert.equal(matchScore(best, tokens), 1, "alias means only one token matches");
  assert.ok(!tokens.every((t) => /[a-z0-9]/.test(t)), "the query is not all-latin");
});

test("a cross-language query keeps the raw recall instead of emptying", () => {
  // "DSH" is an alias for "DeepSeek Harness"; nothing in a title says "dsh".
  // Dropping every result would be worse than returning bilibili's own order.
  const tokens = queryTokens("DSH 插件");
  const title = "全网通告！最全的Pr插件合集".toLowerCase();
  // A partial hit still keeps the set non-empty, so the fallback is not needed
  // here — but if nothing matched, the caller gets `unfiltered: true`.
  assert.ok(tokens.includes("插件"));
  assert.ok(matchScore(title, tokens) > 0);
});
