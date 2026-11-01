/**
 * dsh-bilibili-retrieval — Bilibili retrieval for DeepSeek Harness.
 *
 * ## Register path
 *
 * This plugin registers tools through `ctx.tools.register()` with plain JSON
 * Schema, and imports nothing from `@deepseek-ai/*`.
 *
 * Measured on this host (desktop profile, runtime 0.2.1-rc.2): a plugin
 * installed from an arbitrary directory cannot resolve `@deepseek-ai/dsh-tools`
 * by itself. Node ESM resolves upward from the plugin file, and the only
 * reachable copy is the junction in `.dsh/profiles/node_modules` pointing at
 * the npm-global 0.1.5-alpha.2 tree — a different major line. `register()` only
 * requires `name` plus `output { schema, render }`, so the import is
 * unnecessary, and omitting it removes the failure mode that silently disables
 * community plugins here ("1 entry did not activate … failed to import").
 *
 * ## Channel split
 *
 * High-frequency work (search, metadata, comments) spends the anonymous
 * identity. Low-frequency, high-value work (subtitles, AI summary, uploader
 * listings) spends the scanned-in identity under a tighter budget and a hard
 * per-session cap. Risk control exists at both IP and account level; the account
 * is the one that follows the real user around.
 */

import { BiliClient, BiliError, parseVideoRef } from "./lib/protocol.js";
import {
  clearCredential,
  createLoginQr,
  pollLogin,
  readCredential,
  saveCredential,
  verifyCredential,
} from "./lib/login.js";
import { aiSummary, transcript } from "./lib/subtitle.js";
import { cacheSprite, clearFrames, downloadSprite, frameCacheReport, frameSprite, previewDirectory, pruneFrames } from "./lib/frames.js";
import { mountControlPanel } from "./lib/panel.js";
import {
  renderComments,
  renderSearch,
  renderVideo,
  searchVideos,
  videoComments,
  videoDetail,
} from "./lib/tools.js";

/** Plugin name used by loader diagnostics. */
export const name = "dsh-bilibili-retrieval";

/** Services this plugin needs before it may start. */
export const inject = ["tools"];

/** Description shared by the diagnostic tool. */
const PROBE_DESCRIPTION =
  "Bring-up diagnostic for the bilibili-retrieval plugin. Reports the register path, host network egress, and the state of the anonymous and authenticated channels. Call this first when bilibili retrieval misbehaves.";

/**
 * Append one activation line under `$DSH_HOME/bili/activation.log`.
 *
 * The desktop host keeps no live log, so "did this plugin actually mount in
 * this generation?" is otherwise unanswerable from the filesystem. Failures are
 * swallowed: a diagnostic must never break activation.
 * @returns {Promise<void>}
 */
async function traceActivation() {
  try {
    const { readFile, writeFile, mkdir } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const dir = join(home, "bili");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "activation.log");
    let version = "unknown";
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      version = String(JSON.parse(await readFile(join(here, "package.json"), "utf8")).version ?? "unknown");
    } catch {
      version = "unknown";
    }
    const line =
      new Date().toISOString() + " pid=" + process.pid + " node=" + process.version + " version=" + version;
    let existing = "";
    try {
      existing = await readFile(file, "utf8");
    } catch {
      existing = "";
    }
    const lines = existing.split("\n").filter((entry) => entry.trim().length > 0);
    lines.push(line);
    await writeFile(file, lines.slice(-40).join("\n") + "\n", "utf8");
  } catch {
    // Diagnostic only.
  }
}

/**
 * Load a previously scanned login, if any.
 *
 * The credential lives in its own file rather than `$DSH_HOME/.env` on purpose:
 * every `KEY=VALUE` line of `.env` is injected into every child process the
 * harness starts, which would leak a full login token far beyond this plugin.
 *
 * @param {object} config - row config.
 * @returns {Promise<object | null>} `{sessdata, biliJct, dedeUserId}` or null.
 */
async function loadCredential(config) {
  return await readCredential(config);
}

/**
 * Resolve config defaults without importing the framework's schema library.
 * @param {object} config - raw row config.
 * @returns {object} resolved config.
 */
function resolveConfig(config) {
  const pick = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  return {
    anonMinIntervalMs: pick(config?.anonMinIntervalMs, 2000),
    anonBurst: pick(config?.anonBurst, 5),
    authMinIntervalMs: pick(config?.authMinIntervalMs, 3000),
    authBurst: pick(config?.authBurst, 2),
    authMaxPerSession: pick(config?.authMaxPerSession, 20),
    cacheTtlMetaMs: pick(config?.cacheTtlMetaMs, 24 * 60 * 60 * 1000),
    cacheTtlCommentsMs: pick(config?.cacheTtlCommentsMs, 60 * 60 * 1000),
    cacheTtlSpriteMs: pick(config?.cacheTtlSpriteMs, 7 * 24 * 60 * 60 * 1000),
    requestTimeoutMs: pick(config?.requestTimeoutMs, 20000),
    credentialPath: String(config?.credentialPath ?? ""),
    framesMaxFiles: pick(config?.framesMaxFiles, 12),
    framesMaxBytes: pick(config?.framesMaxBytes, 24 * 1024 * 1024),
  };
}

/** Output schema for the diagnostic tool. */
const PROBE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["channels", "node", "search"],
  properties: {
    channels: {
      type: "object",
      additionalProperties: false,
      required: ["anonymous", "authenticated"],
      properties: {
        anonymous: { type: "string" },
        authenticated: { type: "string" },
      },
    },
    node: { type: "string" },
    search: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "elapsedMs", "count"],
      properties: {
        ok: { type: "boolean" },
        elapsedMs: { type: "integer" },
        count: { type: "integer" },
        error: { type: "string" },
      },
    },
  },
};

/** Output schema for `bili_search`. */
const SEARCH_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["videos"],
  properties: {
    filtered: { type: "integer" },
    requested: { type: "integer" },
    unfiltered: { type: "boolean" },
    videos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["bvid", "title", "author", "play", "durationSeconds", "url"],
        properties: {
          bvid: { type: "string" },
          title: { type: "string" },
          author: { type: "string" },
          mid: { type: "integer" },
          play: { type: "integer" },
          danmaku: { type: "integer" },
          favorites: { type: "integer" },
          like: { type: "integer" },
          durationSeconds: { type: "integer" },
          publishedAt: { type: "integer" },
          description: { type: "string" },
          tag: { type: "string" },
          url: { type: "string" },
        },
      },
    },
  },
};

/** Output schema for `bili_video`. */
const VIDEO_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bvid", "title", "owner", "stat", "url"],
  properties: {
    bvid: { type: "string" },
    aid: { type: "integer" },
    cid: { type: "integer" },
    title: { type: "string" },
    description: { type: "string" },
    owner: {
      type: "object",
      additionalProperties: false,
      required: ["mid", "name"],
      properties: { mid: { type: "integer" }, name: { type: "string" } },
    },
    stat: {
      type: "object",
      additionalProperties: false,
      required: ["view", "like", "favorite", "coin", "reply", "danmaku"],
      properties: {
        view: { type: "integer" },
        danmaku: { type: "integer" },
        reply: { type: "integer" },
        favorite: { type: "integer" },
        coin: { type: "integer" },
        share: { type: "integer" },
        like: { type: "integer" },
      },
    },
    durationSeconds: { type: "integer" },
    publishedAt: { type: "integer" },
    cover: { type: "string" },
    pages: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["page", "cid", "title"],
        properties: {
          page: { type: "integer" },
          cid: { type: "integer" },
          title: { type: "string" },
          durationSeconds: { type: "integer" },
        },
      },
    },
    tags: { type: "array", items: { type: "string" } },
    related: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["bvid", "title", "url"],
        properties: {
          bvid: { type: "string" },
          title: { type: "string" },
          author: { type: "string" },
          play: { type: "integer" },
          url: { type: "string" },
        },
      },
    },
    url: { type: "string" },
  },
};

/** One comment shape, shared by pinned / top / hot. */
const COMMENT_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["user", "like", "text"],
  properties: {
    user: { type: "string" },
    mid: { type: "integer" },
    like: { type: "integer" },
    replyCount: { type: "integer" },
    text: { type: "string" },
    createdAt: { type: "integer" },
  },
};

/** Output schema for `bili_comments`. */
const COMMENTS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["aid", "hot"],
  properties: {
    aid: { type: "integer" },
    // `oneOf` rather than `type: ["object", "null"]`: the registry's schema
    // subset rejects an array-valued `type`, and a nullable field still has to
    // validate when there is no pinned comment.
    pinned: { oneOf: [COMMENT_ITEM_SCHEMA, { type: "null" }] },
    topReplies: { type: "array", items: COMMENT_ITEM_SCHEMA },
    hot: { type: "array", items: COMMENT_ITEM_SCHEMA },
    hasPinned: { type: "boolean" },
    linkComment: { oneOf: [COMMENT_ITEM_SCHEMA, { type: "null" }] },
    pageComplete: { type: "boolean" },
    cursor: { type: "integer" },
    isEnd: { type: "boolean" },
  },
};

/** Output schema for `bili_transcript`. */
const TRANSCRIPT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bvid", "page", "language", "text", "characters"],
  properties: {
    bvid: { type: "string" },
    aid: { type: "integer" },
    cid: { type: "integer" },
    page: { type: "integer" },
    pageTitle: { type: "string" },
    language: { type: "string" },
    languageLabel: { type: "string" },
    isAiGenerated: { type: "boolean" },
    cues: { type: "integer" },
    durationSeconds: { type: "integer" },
    characters: { type: "integer" },
    totalCharacters: { type: "integer" },
    startChar: { type: "integer" },
    endChar: { type: "integer" },
    startSeconds: { type: "integer" },
    endSeconds: { type: "integer" },
    hasMore: { type: "boolean" },
    truncated: { type: "boolean" },
    text: { type: "string" },
    availableTracks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lan", "label"],
        properties: {
          lan: { type: "string" },
          label: { type: "string" },
          ai: { type: "boolean" },
        },
      },
    },
  },
};

/** Output schema for `bili_summary`. */
const SUMMARY_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bvid", "title", "url", "summary"],
  properties: {
    bvid: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    summary: { type: "string" },
    hasSummary: { type: "boolean" },
    outline: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title"],
        properties: {
          title: { type: "string" },
          points: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["timestamp", "content"],
              properties: {
                timestamp: { type: "integer" },
                content: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

/** Output schema for `bili_frames`. */
const FRAMES_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bvid", "title", "url", "spritePath", "columns", "rows", "frameCount"],
  properties: {
    bvid: { type: "string" },
    title: { type: "string" },
    url: { type: "string" },
    page: { type: "integer" },
    spritePath: { type: "string" },
    spriteUrl: { type: "string" },
    columns: { type: "integer" },
    rows: { type: "integer" },
    frameCount: { type: "integer" },
    cellWidth: { type: "integer" },
    cellHeight: { type: "integer" },
    sheetWidth: { type: "integer" },
    sheetHeight: { type: "integer" },
    bytes: { type: "integer" },
    timestamps: { type: "array", items: { type: "integer" } },
  },
};

/**
 * Render a transcript. The text is emitted verbatim inside a tag so the model
 * can read it directly; it is NOT truncated beyond the caller's own cap.
 * @param {object} _args - tool arguments (unused).
 * @param {object} value - declared output value.
 * @returns {{type: string, text: string}[]} content blocks.
 */
function renderTranscript(_args, value) {
  const stamp = (total) => {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, "0");
    return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + s : m + ":" + s;
  };
  const head = [
    "<bilibili_transcript>",
    "<title>" + value.pageTitle + "</title>",
    "<url>https://www.bilibili.com/video/" + value.bvid + "</url>",
    "<page>" + value.page + "</page>",
    "<language>" + value.language + (value.isAiGenerated ? " (AI)" : "") + "</language>",
    "<cues>" + value.cues + "</cues>",
    // Time range lets a caller jump straight to a section instead of estimating
    // position from character share.
    value.hasMore
      ? "<range>" + value.startChar + "-" + value.endChar + " of " + value.totalCharacters +
        " chars (" + stamp(value.startSeconds) + "-" + stamp(value.endSeconds) + " of " +
        stamp(value.durationSeconds) + "); call again with startChar=" + value.endChar + " for the next slice</range>"
      : "<range>" + value.startChar + "-" + value.endChar + " of " + value.totalCharacters +
        " chars (" + stamp(value.startSeconds) + "-" + stamp(value.endSeconds) + ", complete)</range>",
    value.availableTracks.length > 1
      ? "<also_available>" + value.availableTracks.map((track) => track.lan).join(", ") + "</also_available>"
      : "",
    "<transcript>",
    value.text,
    "</transcript>",
    "</bilibili_transcript>",
  ].filter((line) => line.length > 0);
  return [{ type: "text", text: head.join("\n") }];
}

/**
 * Render an AI summary with its outline.
 * @param {object} _args - tool arguments (unused).
 * @param {object} value - declared output value.
 * @returns {{type: string, text: string}[]} content blocks.
 */
function renderSummary(_args, value) {
  const lines = [
    "<bilibili_summary>",
    "<title>" + value.title + "</title>",
    "<url>" + value.url + "</url>",
    "<summary>",
    value.summary,
    "</summary>",
  ];
  if (value.outline.length > 0) {
    lines.push("<outline>");
    for (const section of value.outline) {
      lines.push("  " + section.title);
      for (const point of section.points) {
        const mm = Math.floor(point.timestamp / 60);
        const ss = String(point.timestamp % 60).padStart(2, "0");
        lines.push("    [" + mm + ":" + ss + "] " + point.content);
      }
    }
    lines.push("</outline>");
  }
  lines.push("</bilibili_summary>");
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * Render a frame sprite as a markdown image plus its geometry.
 * @param {object} _args - tool arguments (unused).
 * @param {object} value - declared output value.
 * @returns {{type: string, text: string}[]} content blocks.
 */
function renderFrames(_args, value) {
  const lines = [
    "<bilibili_frames>",
    "<title>" + value.title + "</title>",
    "<url>" + value.url + "</url>",
    "<grid columns=\"" + value.columns + "\" rows=\"" + value.rows + "\" frames=\"" + value.frameCount +
      "\" cell=\"" + value.cellWidth + "x" + value.cellHeight + "\" sheet=\"" + value.sheetWidth + "x" +
      value.sheetHeight + "\"/>",
  ];
  // Timestamps are unreliable per video (the same request returns 48 or 0), and
  // 40 numbers is a lot of tokens for marginal value — cap hard.
  if (value.timestamps.length > 0) {
    lines.push("<timestamps>" + value.timestamps.slice(0, 12).join(",") + "…</timestamps>");
  }
  lines.push("");
  lines.push("![预览帧](" + value.spritePath + ")");
  lines.push("");
  lines.push("按 " + value.columns + "×" + value.rows + " 网格排列的 " + value.frameCount + " 帧，阅读顺序为从左到右、从上到下。");
  lines.push("</bilibili_frames>");
  return [{ type: "text", text: lines.join("\n") }];
}

/** Output schema for `bili_cache`. */
const CACHE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "files", "bytes", "locations", "message"],
  properties: {
    action: { type: "string" },
    files: { type: "integer" },
    bytes: { type: "integer" },
    removed: { type: "integer" },
    freedBytes: { type: "integer" },
    message: { type: "string" },
    locations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dir", "files", "bytes"],
        properties: {
          dir: { type: "string" },
          files: { type: "integer" },
          bytes: { type: "integer" },
        },
      },
    },
  },
};

/**
 * Render the frame-cache report.
 * @param {object} _args - tool arguments (unused).
 * @param {object} value - declared output value.
 * @returns {{type: string, text: string}[]} content blocks.
 */
function renderCache(_args, value) {
  const lines = ["<bili_cache action=\"" + value.action + "\">", value.message];
  for (const row of value.locations) {
    lines.push("  " + row.dir + " — " + row.files + " 张 / " + Math.round(row.bytes / 1024) + " KB");
  }
  lines.push("</bili_cache>");
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * Clamp a model-supplied integer argument.
 * @param {unknown} value - raw value.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} the clamped integer.
 */
function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/** Output schema for `bili_login`. */
const LOGIN_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "state", "message"],
  properties: {
    action: { type: "string" },
    state: {
      type: "string",
      enum: ["logged_in", "not_logged_in", "expired", "scanned", "waiting", "logged_out"],
    },
    message: { type: "string" },
    mid: { type: "integer" },
    name: { type: "string" },
    qrPath: { type: "string" },
  },
};

/**
 * Render a login outcome. When a QR was written, the reply carries it as a
 * markdown image so the client displays it inline — no attachment service
 * needed, which matters because this plugin deliberately imports no framework
 * packages.
 * @param {object} _args - tool arguments (unused).
 * @param {object} value - declared output value.
 * @returns {{type: string, text: string}[]} content blocks.
 */
function renderLogin(_args, value) {
  const lines = ["<bili_login action=\"" + value.action + "\" state=\"" + value.state + "\">"];
  lines.push(value.message);
  if (value.qrPath) {
    lines.push("");
    lines.push("![Bilibili 登录二维码](<" + value.qrPath + ">)");
    lines.push("");
    lines.push("若图片未显示，直接打开：" + value.qrPath);
  }
  lines.push("</bili_login>");
  return [{ type: "text", text: lines.join("\n") }];
}

/**
 * Mount every tool.
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 * @param {object} config - row config from cordis.patch.yml.
 */
export function apply(ctx, config) {
  let resolved = resolveConfig(config);
  void traceActivation();

  // One client per plugin instance, so the budget and cache are shared by every
  // tool — that shared state is the whole point of a protocol layer.
  const client = new BiliClient({ config: resolved });

  // Load any scanned credential asynchronously. Tools read `client.credential`
  // at call time, so a login that lands later takes effect without a restart.
  void loadCredential(resolved).then((credential) => {
    if (credential !== null) client.credential = credential;
  });

  /**
   * Merge a config patch from the control panel.
   *
   * Only the in-memory view changes: writing back to the profile would make the
   * host recompose every plugin on the machine just because someone nudged a
   * rate limit. The patch is also pushed into the live client so the new budget
   * takes effect without a restart.
   *
   * @param {object} patch - validated numeric overrides.
   * @returns {object} the effective config after the merge.
   */
  const applyConfigPatch = (patch) => {
    resolved = { ...resolved, ...patch };
    if (client.config !== undefined) client.config = resolved;
    if (client.anonBucket !== undefined && patch.anonMinIntervalMs !== undefined) {
      client.anonBucket.minIntervalMs = patch.anonMinIntervalMs;
    }
    if (client.anonBucket !== undefined && patch.anonBurst !== undefined) {
      client.anonBucket.capacity = patch.anonBurst;
    }
    if (client.authBucket !== undefined && patch.authMinIntervalMs !== undefined) {
      client.authBucket.minIntervalMs = patch.authMinIntervalMs;
    }
    if (client.authBucket !== undefined && patch.authBurst !== undefined) {
      client.authBucket.capacity = patch.authBurst;
    }
    return resolved;
  };

  // Control panel. Optional: without a webServer (headless CLI, tests) the tools
  // still work, there is just no UI to drive them from.
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() =>
      mountControlPanel(webCtx, {
        config: () => resolved,
        client,
        login: {
          createLoginQr,
          pollLogin,
          readCredential,
          clearCredential,
          verifyCredential,
          saveCredential,
        },
        frames: { frameCacheReport, clearFrames, pruneFrames },
        applyConfig: applyConfigPatch,
      })
    );
  });

  ctx.effect(() => {
    const disposers = [];

    disposers.push(
      ctx.tools.register({
        name: "bili_probe",
        description: PROBE_DESCRIPTION,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            keyword: { type: "string", description: "Optional probe search term (default: dsh 插件)." },
          },
        },
        output: {
          schema: PROBE_OUTPUT_SCHEMA,
          render: (_args, value) => [
            {
              type: "text",
              text: [
                "<bili_probe>",
                "<anonymous>" + value.channels.anonymous + "</anonymous>",
                "<authenticated>" + value.channels.authenticated + "</authenticated>",
                "<node>" + value.node + "</node>",
                "<search ok=\"" +
                  value.search.ok +
                  "\" ms=\"" +
                  value.search.elapsedMs +
                  "\" count=\"" +
                  value.search.count +
                  "\"" +
                  (value.search.error ? " error=\"" + value.search.error + "\"" : "") +
                  "/>",
                "</bili_probe>",
              ].join("\n"),
            },
          ],
        },
        timeoutMs: resolved.requestTimeoutMs + 10000,
        async execute(args, exec) {
          const keyword = String(args?.keyword ?? "dsh 插件").trim() || "dsh 插件";
          const started = Date.now();
          let ok = true;
          let count = 0;
          let error;
          try {
            const probe = await searchVideos({ keyword, limit: 3 }, client, exec?.signal);
            count = probe.videos.length;
          } catch (cause) {
            ok = false;
            error = cause instanceof BiliError ? cause.code : "BILIBILI_REQUEST_FAILED";
          }
          return {
            channels: {
              anonymous:
                "ready (budget " + resolved.anonMinIntervalMs + "ms/burst " + resolved.anonBurst + ")",
              authenticated: client.hasCredential
                ? "scanned login loaded (budget " +
                  resolved.authMinIntervalMs +
                  "ms/burst " +
                  resolved.authBurst +
                  ", cap " +
                  resolved.authMaxPerSession +
                  "/session)"
                : "not logged in — subtitle and AI-summary tools will report BILIBILI_LOGIN_REQUIRED",
            },
            node: process.version,
            search: { ok, elapsedMs: Date.now() - started, count, ...(error === undefined ? {} : { error }) },
          };
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_search",
        description:
          "Search Bilibili for Chinese video tutorials, courses and creator resource links. Returns title, uploader, play/like/favorite counts, duration, date, description, tags.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["keyword"],
          properties: {
            keyword: { type: "string", description: "Search terms, Chinese or English." },
            limit: { type: "integer", description: "Max results (1-30, default 10)." },
            strict: {
              type: "boolean",
              description: "Keep only results matching every query token (default false).",
            },
          },
        },
        output: { schema: SEARCH_OUTPUT_SCHEMA, render: renderSearch },
        timeoutMs: resolved.requestTimeoutMs + 10000,
        async execute(args, exec) {
          const keyword = String(args?.keyword ?? "").trim();
          if (keyword.length === 0) throw new BiliError("BILIBILI_BAD_ARGUMENT", "keyword is required");
          const limit = clampInt(args?.limit, 10, 1, 30);
          const result = await searchVideos(
            { keyword, limit, strict: args?.strict === true },
            client,
            exec?.signal
          );
          return result;
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_video",
        description:
          "One Bilibili video's description (full, preserving line breaks), chapter list, stats and tags. Takes a BV id, av number or URL.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["video"],
          properties: {
            video: { type: "string", description: "BV id, av number, or bilibili video URL." },
            related: {
              type: "integer",
              description: "How many related videos to include (0-20, default 0 = none).",
            },
          },
        },
        output: { schema: VIDEO_OUTPUT_SCHEMA, render: renderVideo },
        timeoutMs: resolved.requestTimeoutMs + 10000,
        async execute(args, exec) {
          const ref = parseVideoRef(args?.video);
          return await videoDetail(ref, client, exec?.signal, { related: clampInt(args?.related, 0, 0, 20) });
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_comments",
        description:
          "A Bilibili video's comments, led by the creator's pinned comment (often the repo link, dataset or a caveat).",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["video"],
          properties: {
            video: { type: "string", description: "BV id, av number, or bilibili video URL." },
            limit: { type: "integer", description: "Max hot comments (1-40, default 15)." },
          },
        },
        output: { schema: COMMENTS_OUTPUT_SCHEMA, render: renderComments },
        timeoutMs: resolved.requestTimeoutMs + 10000,
        async execute(args, exec) {
          const ref = parseVideoRef(args?.video);
          const limit = clampInt(args?.limit, 15, 1, 40);
          return await videoComments({ ref, limit }, client, exec?.signal);
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_login",
        description:
          "Optional Bilibili login. start shows a QR to scan, status checks it, logout forgets it. Only subtitles and the AI summary need it — search, video, comments and frames work without.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: ["start", "status", "logout"],
              description: "start: show a QR and wait. status: check. logout: forget.",
            },
            waitSeconds: {
              type: "integer",
              description: "For start: seconds to wait for the scan (5-120, default 45).",
            },
          },
        },
        output: { schema: LOGIN_OUTPUT_SCHEMA, render: renderLogin },
        // The wait budget plus one poll timeout, so the cooperative timeout
        // never fires before the wait itself would.
        timeoutMs: 130000 + resolved.requestTimeoutMs,
        async execute(args, exec) {
          const action = String(args?.action ?? "status");
          if (action === "logout") {
            const removed = await clearCredential(resolved);
            client.credential = null;
            client.resetSession();
            return { action, state: removed ? "logged_out" : "not_logged_in", message: removed ? "已清除保存的登录凭据" : "本来就没有登录" };
          }

          if (action === "status") {
            const stored = await readCredential(resolved);
            if (stored === null) {
              return { action, state: "not_logged_in", message: "尚未登录；匿名能力（搜索/元数据/评论）可用" };
            }
            const check = await verifyCredential(resolved, stored, exec?.signal);
            if (check.ok) {
              client.credential = stored;
              return {
                action,
                state: "logged_in",
                mid: check.mid,
                name: check.name,
                message: "登录有效：" + check.name + " (mid " + check.mid + ")",
              };
            }
            return { action, state: "expired", message: "登录已失效（" + (check.reason ?? "unknown") + "），请重新 start" };
          }

          // action === "start"
          const waitSeconds = clampInt(args?.waitSeconds, 45, 5, 120);
          const qr = await createLoginQr(resolved, exec?.signal, await previewDirectory(ctx, exec));
          const deadline = Date.now() + waitSeconds * 1000;
          let lastState = "waiting";
          while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
            if (exec?.signal?.aborted) break;
            let poll;
            try {
              poll = await pollLogin(resolved, qr.qrcodeKey, exec?.signal);
            } catch {
              continue;
            }
            lastState = poll.state;
            if (poll.state === "success") {
              await saveCredential(resolved, poll.credential);
              client.credential = poll.credential;
              client.resetSession();
              const check = await verifyCredential(resolved, poll.credential, exec?.signal);
              return {
                action,
                state: "logged_in",
                mid: check.mid,
                name: check.name,
                qrPath: qr.pngPath,
                message:
                  "扫码登录成功" + (check.ok ? "：" + check.name + " (mid " + check.mid + ")" : "") +
                  "。字幕、AI 摘要、UP 投稿列表现已解锁。",
              };
            }
            if (poll.state === "expired") {
              return {
                action,
                state: "expired",
                qrPath: qr.pngPath,
                message: "二维码已过期，请再次调用 bili_login start 重新生成。",
              };
            }
          }
          return {
            action,
            state: lastState === "scanned" ? "scanned" : "waiting",
            qrPath: qr.pngPath,
            message:
              lastState === "scanned"
                ? "已扫码，请在手机上点确认，然后调用 bili_login status。"
                : "二维码已生成，等待扫码。扫完后调用 bili_login status 确认。",
          };
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_transcript",
        description:
          "A Bilibili video's subtitle text, in slices. Needs a saved login (bili_login start). Returns a range plus hasMore; pass startChar to read on.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["video"],
          properties: {
            video: { type: "string", description: "BV id, av number, or bilibili video URL." },
            page: { type: "integer", description: "Which part for a multi-part video (default 1)." },
            language: { type: "string", description: "Preferred track tag, e.g. zh-CN, en-US." },
            maxChars: { type: "integer", description: "Characters in this slice (1000-20000, default 4000)." },
            startChar: { type: "integer", description: "Offset into the transcript (default 0)." },
          },
        },
        output: { schema: TRANSCRIPT_OUTPUT_SCHEMA, render: renderTranscript },
        timeoutMs: resolved.requestTimeoutMs + 20000,
        async execute(args, exec) {
          const ref = parseVideoRef(args?.video);
          const detail = await videoDetail(ref, client, exec?.signal);
          return await transcript(
            {
              detail,
              page: clampInt(args?.page, 1, 1, 999),
              language: String(args?.language ?? ""),
              maxChars: clampInt(args?.maxChars, 4000, 1000, 20000),
              startChar: clampInt(args?.startChar, 0, 0, 10000000),
            },
            client,
            exec?.signal
          );
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_summary",
        description:
          "Bilibili's own AI summary and outline for a video. Needs a login, and bilibili gates it above a normal login — if it refuses, use bili_transcript.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["video"],
          properties: {
            video: { type: "string", description: "BV id, av number, or bilibili video URL." },
          },
        },
        output: { schema: SUMMARY_OUTPUT_SCHEMA, render: renderSummary },
        timeoutMs: resolved.requestTimeoutMs + 10000,
        async execute(args, exec) {
          const ref = parseVideoRef(args?.video);
          const detail = await videoDetail(ref, client, exec?.signal);
          const summary = await aiSummary(client, detail, exec?.signal);
          return { bvid: detail.bvid, title: detail.title, url: detail.url, ...summary };
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_frames",
        description:
          "A video's preview sprite: one image holding a grid of sampled frames, so you can see what it shows. No ffmpeg needed. Keeps at most a few sheets on disk.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["video"],
          properties: {
            video: { type: "string", description: "BV id, av number, or bilibili video URL." },
            page: { type: "integer", description: "Which part for a multi-part video (default 1)." },
          },
        },
        output: { schema: FRAMES_OUTPUT_SCHEMA, render: renderFrames },
        timeoutMs: resolved.requestTimeoutMs + 20000,
        async execute(args, exec) {
          const ref = parseVideoRef(args?.video);
          const detail = await videoDetail(ref, client, exec?.signal);
          const pageIndex = clampInt(args?.page, 1, 1, 999);
          const target = detail.pages.find((entry) => entry.page === pageIndex) ?? detail.pages[0];
          const cid = target?.cid ?? detail.cid;
          const sprite = await frameSprite(client, detail.aid, cid, exec?.signal);
          const downloaded = await downloadSprite(sprite.url, exec?.signal);
          const dir = await previewDirectory(ctx, exec);
          const path = await cacheSprite(
            downloaded.data,
            detail.bvid + "-p" + (target?.page ?? 1),
            resolved,
            dir
          );
          return {
            bvid: detail.bvid,
            title: detail.title,
            url: detail.url,
            page: target?.page ?? 1,
            spritePath: path,
            spriteUrl: sprite.url,
            columns: sprite.columns,
            rows: sprite.rows,
            frameCount: sprite.frameCount,
            cellWidth: sprite.cellWidth,
            cellHeight: sprite.cellHeight,
            sheetWidth: sprite.sheetWidth,
            sheetHeight: sprite.sheetHeight,
            bytes: downloaded.bytes,
            timestamps: sprite.timestamps,
          };
        },
      })
    );

    disposers.push(
      ctx.tools.register({
        name: "bili_cache",
        description:
          "Report or clear the preview images bili_frames saved on disk. Reports total files and bytes per directory, including a stale one from older versions.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["action"],
          properties: {
            action: {
              type: "string",
              enum: ["report", "clear"],
              description: "report: show footprint. clear: delete every saved frame sheet.",
            },
          },
        },
        output: { schema: CACHE_OUTPUT_SCHEMA, render: renderCache },
        timeoutMs: 20000,
        async execute(args, exec) {
          const action = String(args?.action ?? "report");
          const workspaceDir = await previewDirectory(ctx, exec);
          // previewDirectory returns `<workspace>/bili-frames`; the report wants
          // the workspace itself.
          const workspaceRoot = workspaceDir.length > 0 ? workspaceDir.replace(/[\\/]bili-frames$/, "") : "";
          const locations = await frameCacheReport(resolved, workspaceRoot);
          if (action === "clear") {
            let removed = 0;
            let freedBytes = 0;
            for (const row of locations) {
              const result = await clearFrames(row.dir);
              removed += result.removed;
              freedBytes += result.freedBytes;
            }
            return {
              action,
              files: 0,
              bytes: 0,
              locations: [],
              removed,
              freedBytes,
              message:
                removed > 0
                  ? "已删除 " + removed + " 张预览图，释放 " + Math.round(freedBytes / 1024) + " KB"
                  : "没有可删除的预览图",
            };
          }
          const files = locations.reduce((n, row) => n + row.files, 0);
          const bytes = locations.reduce((n, row) => n + row.bytes, 0);
          return {
            action,
            files,
            bytes,
            locations,
            removed: 0,
            freedBytes: 0,
            message:
              files === 0
                ? "没有占用磁盘的预览图"
                : "共 " + files + " 张，占 " + Math.round(bytes / 1024) + " KB（上限 " +
                  resolved.framesMaxFiles + " 张 / " + Math.round(resolved.framesMaxBytes / 1024 / 1024) + " MB）",
          };
        },
      })
    );

    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "bilibili-retrieval: tools");

  // The prompt registry is optional: absent in headless/minimal compositions,
  // and a plugin that required it would simply not activate there.
  ctx.inject(["systemPrompt"], (sctx) => {
    sctx.effect(() => {
      const disposeSection = sctx.systemPrompt.section({
        name: "tool:bilibili-retrieval",
        order: 112,
        text: [
          "Bilibili: bili_search finds Chinese video tutorials; bili_video reads a video's description and chapters;",
          "bili_comments surfaces the creator's pinned resource link; bili_transcript reads subtitle text in slices",
          "(follow hasMore with startChar — do not request the whole transcript at once).",
          "Cite the video URL as a markdown link.",
        ].join(" "),
      });
      return () => {
        disposeSection();
      };
    }, "bilibili-retrieval: prompt section");
  });
}

export default { name, inject, apply };
