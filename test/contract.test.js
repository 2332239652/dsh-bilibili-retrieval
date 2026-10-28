// Contract tests: every tool's returned value must satisfy its declared output
// schema. The registry enforces `additionalProperties: false`, so a field added
// to a tool without updating its schema fails at call time in production —
// which is exactly how bili_transcript's paging fields first shipped broken.
import assert from "node:assert/strict";
import test from "node:test";

const mod = await import("../index.js");

const TYPES = {
  string: (v) => typeof v === "string",
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === "object" && !Array.isArray(v),
  null: (v) => v === null,
};

/**
 * Walk a value against a JSON Schema subset (type / properties / required /
 * additionalProperties / items / enum).
 * @param {unknown} value - candidate value.
 * @param {object} schema - declared schema.
 * @param {string} path - diagnostic path.
 * @param {string[]} problems - collector.
 * @returns {void}
 */
function walk(value, schema, path, problems) {
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((arm) => {
      const inner = [];
      walk(value, arm, path, inner);
      return inner.length === 0;
    });
    if (matches.length !== 1) {
      problems.push(`${path}: matched ${matches.length} oneOf arms, expected exactly 1`);
    }
    return;
  }
  if (schema.type !== undefined) {
    const checker = TYPES[schema.type];
    if (checker === undefined) {
      problems.push(`${path}: unknown schema type ${schema.type}`);
      return;
    }
    if (!checker(value)) {
      problems.push(`${path}: expected ${schema.type}, got ${Array.isArray(value) ? "array" : typeof value}`);
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type === "object" && schema.properties !== undefined) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${path}.${key}: required but missing`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(schema.properties, key)) {
          problems.push(`${path}.${key}: not declared (additionalProperties: false)`);
        }
      }
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, key)) walk(value[key], child, `${path}.${key}`, problems);
    }
  }
  if (schema.type === "array" && schema.items !== undefined) {
    value.forEach((item, index) => walk(item, schema.items, `${path}[${index}]`, problems));
  }
}

/** Collect the registered tool definitions. */
function definitions() {
  const registered = [];
  mod.apply(
    {
      effect: (cb) => { const d = cb(); return () => typeof d === "function" && d(); },
      inject: (_s, cb) => cb({
        effect: (f) => { const d = f(); return () => typeof d === "function" && d(); },
        systemPrompt: { section: () => () => {} },
      }),
      tools: { register: (d) => { registered.push(d); return () => {}; } },
    },
    {}
  );
  return registered;
}

test("every declared output schema is a supported subset", () => {
  const ALLOWED = new Set([
    "type", "oneOf", "properties", "required", "additionalProperties",
    "items", "enum", "const", "description", "title", "default", "examples",
  ]);
  const problems = [];
  for (const def of definitions()) {
    (function scan(node, path) {
      if (node === null || typeof node !== "object") return;
      for (const key of Object.keys(node)) {
        if (!ALLOWED.has(key)) problems.push(`${def.name} ${path}.${key}`);
      }
      if (Array.isArray(node.type)) problems.push(`${def.name} ${path}.type is an array`);
      for (const [key, child] of Object.entries(node.properties ?? {})) scan(child, `${path}.${key}`);
      if (node.items) scan(node.items, `${path}[]`);
    })(def.output.schema, "schema");
  }
  assert.deepEqual(problems, []);
});

test("transcript paging fields are declared in the output schema", () => {
  // Regression: the paging fields were added to the returned value but not to
  // the schema, so the registry rejected the result with
  // "value.hasMore is not a declared property".
  const transcript = definitions().find((d) => d.name === "bili_transcript");
  for (const field of ["totalCharacters", "startChar", "endChar", "hasMore"]) {
    assert.ok(
      Object.hasOwn(transcript.output.schema.properties, field),
      `${field} must be declared`
    );
  }
});

test("a nullable field validates both with and without a value", () => {
  // Regression: `pinned` used `type: ["object", "null"]`, which the registry's
  // schema subset rejects (type must be a single string). oneOf fixes it, and
  // both branches have to be exercised.
  const comments = definitions().find((d) => d.name === "bili_comments");
  const base = { aid: 1, topReplies: [], hot: [], hasPinned: false, linkComment: null, pageComplete: false, cursor: 0, isEnd: true };
  const withPin = [];
  walk({ ...base, pinned: { user: "u", like: 1, text: "t" } }, comments.output.schema, "c", withPin);
  assert.deepEqual(withPin, [], "a present pinned comment must validate");
  const withoutPin = [];
  walk({ ...base, pinned: null }, comments.output.schema, "c", withoutPin);
  assert.deepEqual(withoutPin, [], "a null pinned comment must validate");
});

test("a representative value satisfies every output schema", () => {
  const samples = {
    bili_probe: { channels: { anonymous: "a", authenticated: "b" }, node: "v", search: { ok: true, elapsedMs: 1, count: 0 } },
    bili_search: { videos: [], filtered: 0, requested: 0, unfiltered: false },
    bili_video: {
      bvid: "BV1", aid: 1, cid: 2, title: "t", description: "d",
      owner: { mid: 1, name: "n" },
      stat: { view: 1, danmaku: 1, reply: 1, favorite: 1, coin: 1, share: 1, like: 1 },
      durationSeconds: 1, publishedAt: 1, cover: "c",
      pages: [{ page: 1, cid: 2, title: "p", durationSeconds: 1 }],
      tags: ["a"], related: [{ bvid: "BV2", title: "t", author: "a", play: 1, url: "u" }], url: "u",
    },
    bili_comments: { aid: 1, pinned: null, topReplies: [], hot: [], hasPinned: false, linkComment: null, pageComplete: false, cursor: 0, isEnd: true },
    bili_login: { action: "status", state: "logged_in", message: "m", mid: 1, name: "n", qrPath: "p" },
    bili_transcript: { bvid: "BV1", aid: 1, cid: 2, page: 1, pageTitle: "p", language: "zh", languageLabel: "中文", isAiGenerated: true, cues: 1, durationSeconds: 1, characters: 10, totalCharacters: 100, startChar: 0, endChar: 10, startSeconds: 0, endSeconds: 30, hasMore: true, truncated: true, text: "t", availableTracks: [] },
    bili_summary: { bvid: "BV1", title: "t", url: "u", summary: "s", hasSummary: true, outline: [] },
    bili_frames: {
      bvid: "BV1", title: "t", url: "u", page: 1, spritePath: "p", spriteUrl: "s",
      columns: 10, rows: 10, frameCount: 100, cellWidth: 1, cellHeight: 1,
      sheetWidth: 10, sheetHeight: 10, bytes: 1, timestamps: [0, 5],
    },
    bili_cache: {
      action: "report", files: 1, bytes: 100, removed: 0, freedBytes: 0, message: "m",
      locations: [{ dir: "d", files: 1, bytes: 100 }],
    },
  };
  const problems = [];
  for (const def of definitions()) {
    const sample = samples[def.name];
    assert.ok(sample !== undefined, `no sample for ${def.name} — add one`);
    walk(sample, def.output.schema, def.name, problems);
  }
  assert.deepEqual(problems, []);
});

test("the render function returns text content blocks for every tool", () => {
  const samples = {
    bili_probe: { channels: { anonymous: "a", authenticated: "b" }, node: "v", search: { ok: true, elapsedMs: 1, count: 0 } },
    bili_search: { videos: [{ bvid: "BV1", title: "t", author: "a", play: 1, durationSeconds: 1, url: "u", publishedAt: 1 }] },
    bili_video: { bvid: "BV1", title: "t", owner: { mid: 1, name: "n" }, stat: { view: 1, like: 1, favorite: 1, coin: 1, reply: 1, danmaku: 1 }, url: "u", description: "", tags: [], pages: [], related: [] },
    bili_comments: { aid: 1, pinned: { user: "u", like: 1, text: "t" }, topReplies: [], hot: [], hasPinned: true, linkComment: null, pageComplete: false, cursor: 0, isEnd: true },
    bili_login: { action: "start", state: "waiting", message: "m", qrPath: "p" },
    bili_transcript: { bvid: "BV1", page: 1, pageTitle: "p", language: "zh", isAiGenerated: false, cues: 1, characters: 1, totalCharacters: 1, startChar: 0, endChar: 1, startSeconds: 0, endSeconds: 5, hasMore: false, truncated: false, text: "t", availableTracks: [] },
    bili_summary: { bvid: "BV1", title: "t", url: "u", summary: "s", outline: [] },
    bili_frames: { bvid: "BV1", title: "t", url: "u", spritePath: "p", columns: 10, rows: 10, frameCount: 100, cellWidth: 1, cellHeight: 1, sheetWidth: 1, sheetHeight: 1, timestamps: [] },
    bili_cache: { action: "report", files: 0, bytes: 0, locations: [], message: "m" },
  };
  for (const def of definitions()) {
    const blocks = def.output.render({}, samples[def.name]);
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `${def.name} must render at least one block`);
    assert.equal(blocks[0].type, "text", `${def.name} must render text`);
    assert.ok(blocks[0].text.length > 0, `${def.name} must render non-empty text`);
  }
});
