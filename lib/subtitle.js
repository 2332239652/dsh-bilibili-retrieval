/**
 * Subtitle and AI-summary retrieval — the authenticated channel.
 *
 * Measured reality that shapes this module:
 *
 *  - Anonymous callers get `need_login_subtitle: true` and an empty track list.
 *  - `view.subtitle.list` may carry full track metadata (language, ai_type,
 *    is_lock, author) while every `subtitle_url` is an empty string. Login
 *    *unlocks the URL*; it does not *create* tracks. A video with no track has
 *    none after login either.
 *  - `need_login_subtitle` is readable anonymously and is therefore the cheap
 *    pre-check: it tells the user whether logging in would help *before*
 *    spending an authenticated request.
 *  - The subtitle JSON lives on a CDN that rejects an anonymous fetch with 403;
 *    the `subtitle_url` itself is pre-signed, so it is fetched WITHOUT the
 *    cookie.
 */

import { BiliError } from "./protocol.js";

/** Preferred language order when picking a track. */
const LANGUAGE_PREFERENCE = ["zh-Hans", "zh-CN", "zh-Hant", "zh-HK", "zh-TW", "ai-zh", "en-US", "en"];

/**
 * Rank a subtitle track for selection.
 * @param {object} track - one `subtitles[]` entry.
 * @returns {number} lower is better.
 */
function rankTrack(track) {
  const lan = String(track?.lan ?? "");
  const index = LANGUAGE_PREFERENCE.indexOf(lan);
  const base = index === -1 ? 100 : index;
  // An AI-generated track is usually complete for auto-captioned uploads; a
  // locked track needs the login we already have at this point.
  return base + (Number(track?.ai_type ?? 0) > 0 ? 0 : 0.5);
}

/**
 * Ask what subtitle state a video is in, without spending the auth channel.
 *
 * `x/player/v2` answers anonymously and exposes `need_login_subtitle`, which is
 * the field that decides whether a login is worth prompting for.
 *
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {number} aid - numeric video id.
 * @param {number} cid - page id.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<{needLogin: boolean, tracks: object[], probed: boolean}>}
 */
export async function subtitleAvailability(client, aid, cid, signal) {
  const data = await client.requestJson(
    "anonymous",
    "https://api.bilibili.com/x/player/v2?aid=" + aid + "&cid=" + cid,
    { cacheTtlMs: 10 * 60 * 1000, signal }
  );
  const tracks = Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : [];
  return {
    needLogin: Boolean(data?.need_login_subtitle),
    probed: true,
    tracks: tracks.map((track) => ({
      lan: String(track?.lan ?? ""),
      lanDoc: String(track?.lan_doc ?? ""),
      aiType: Number(track?.ai_type ?? 0),
      hasUrl: typeof track?.subtitle_url === "string" && track.subtitle_url.length > 0,
    })),
  };
}

/**
 * Fetch the subtitle tracks for one page, on the authenticated channel.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {number} aid - numeric video id.
 * @param {number} cid - page id.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<object[]>} tracks with `url` resolved.
 */
async function fetchTracks(client, aid, cid, signal) {
  const data = await client.requestWbi(
    "auth",
    "/x/player/wbi/v2",
    { aid: String(aid), cid: String(cid) },
    { cacheTtlMs: 10 * 60 * 1000, signal }
  );
  const tracks = Array.isArray(data?.subtitle?.subtitles) ? data.subtitle.subtitles : [];
  return tracks
    .filter((track) => typeof track?.subtitle_url === "string" && track.subtitle_url.length > 0)
    .map((track) => ({
      lan: String(track.lan ?? ""),
      lanDoc: String(track.lan_doc ?? ""),
      aiType: Number(track.ai_type ?? 0),
      url: String(track.subtitle_url).startsWith("//")
        ? "https:" + track.subtitle_url
        : String(track.subtitle_url),
    }))
    .sort((a, b) => rankTrack(a) - rankTrack(b));
}

/**
 * Download and flatten one subtitle JSON body.
 *
 * Deliberately cookie-free: the URL is already signed, and the CDN refuses a
 * cookie-carrying request from a non-bilibili origin.
 *
 * @param {string} url - absolute subtitle URL.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<{text: string, cues: number, durationSeconds: number}>}
 */
async function downloadSubtitle(url, signal) {
  const timeout = AbortSignal.timeout(20000);
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  });
  if (!response.ok) {
    throw new BiliError(
      "BILIBILI_SUBTITLE_FETCH_FAILED",
      "subtitle CDN answered HTTP " + response.status
    );
  }
  const body = await response.json();
  const cues = Array.isArray(body?.body) ? body.body : [];
  if (cues.length === 0) {
    throw new BiliError("BILIBILI_SUBTITLES_UNAVAILABLE", "the subtitle track was empty");
  }
  // Merge cues into lines, breaking on sentence enders and long gaps so the
  // transcript reads as prose rather than one giant run-on.
  const lines = [];
  let current = "";
  let currentStart = 0;
  let previousEnd = 0;
  for (const cue of cues) {
    const text = String(cue?.content ?? "").replace(/\s+/g, " ").trim();
    if (text.length === 0) continue;
    const start = Number(cue?.from ?? 0);
    const end = Number(cue?.to ?? start);
    const gap = start - previousEnd;
    previousEnd = end;
    if (current.length > 0 && (gap > 2 || /[。！？!?]$/.test(current))) {
      lines.push({ at: currentStart, text: current });
      current = "";
    }
    if (current.length === 0) currentStart = start;
    current += text;
    if (/[。！？!?]$/.test(text) || current.length > 120) {
      lines.push({ at: currentStart, text: current });
      current = "";
    }
  }
  if (current.length > 0) lines.push({ at: currentStart, text: current });
  const durationSeconds = cues.length > 0 ? Number(cues[cues.length - 1]?.to ?? 0) : 0;
  return { lines, cues: cues.length, durationSeconds };
}

/**
 * Render merged lines as text with `[mm:ss]` anchors.
 *
 * The anchors exist because a caller asking "what does this video cover, and
 * when" previously had to estimate positions from character share — one
 * subagent reported ±1 minute of error doing exactly that. One anchor per line
 * is roughly 8 characters against a ~120-character line, so the cost is ~7%.
 *
 * @param {{at: number, text: string}[]} lines - merged transcript lines.
 * @returns {string} anchored transcript text.
 */
function withAnchors(lines) {
  const pad = (n) => String(n).padStart(2, "0");
  return lines
    .map((line) => {
      const total = Math.max(0, Math.round(line.at));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      const stamp = h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
      return "[" + stamp + "] " + line.text;
    })
    .join("\n");
}

/**
 * Retrieve a transcript for one page.
 *
 * Three-step degradation, in the order that spends the least:
 *  1. Anonymous availability probe — is a login even useful here?
 *  2. Authenticated track list — resolve the signed URL.
 *  3. Cookie-free CDN download — flatten to text.
 *
 * @param {object} params - request parameters.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {object} params.detail - result of `videoDetail`.
 * @param {number} [params.page] - 1-based page number.
 * @param {string} [params.language] - preferred language tag.
 * @param {number} [params.maxChars] - characters to return in this slice.
 * @param {number} [params.startChar] - offset into the transcript for paging.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<object>} the transcript slice.
 */
export async function transcript(
  { detail, page = 1, language = "", maxChars = 6000, startChar = 0 },
  client,
  signal
) {
  const pageIndex = Math.max(1, Math.trunc(page));
  const target = detail.pages.find((entry) => entry.page === pageIndex) ?? detail.pages[0];
  const cid = target?.cid ?? detail.cid;

  // 1. anonymous probe
  const availability = await subtitleAvailability(client, detail.aid, cid, signal);

  if (!client.hasCredential) {
    throw new BiliError(
      "BILIBILI_LOGIN_REQUIRED",
      availability.needLogin
        ? "this video has a subtitle track, but bilibili only releases its URL to a logged-in caller. Run bili_login start to unlock it (search, metadata, comments and frames already work anonymously)."
        : "no subtitle track is reachable anonymously for this page. Run bili_login start if you expect one."
    );
  }

  // 2. authenticated track list
  const tracks = await fetchTracks(client, detail.aid, cid, signal);
  if (tracks.length === 0) {
    throw new BiliError(
      "BILIBILI_SUBTITLES_UNAVAILABLE",
      availability.needLogin
        ? "the logged-in account still sees no subtitle URL for this page"
        : "this video has no subtitle track at all — logging in does not create one"
    );
  }

  const wanted = String(language ?? "").trim();
  const chosen =
    (wanted.length > 0 ? tracks.find((track) => track.lan === wanted) : undefined) ?? tracks[0];

  // 3. cookie-free download
  const subtitle = await downloadSubtitle(chosen.url, signal);
  const anchored = withAnchors(subtitle.lines);

  // Slice rather than truncate: a long lecture must be readable in pages, not
  // dumped as one 25k-token wall (the previous default was 80000 characters).
  // Slicing happens on line boundaries so a page never starts mid-sentence.
  const total = anchored.length;
  const offset = Math.max(0, Math.min(Math.trunc(Number(startChar) || 0), total));
  let endChar = Math.min(total, offset + Math.max(1, Math.trunc(Number(maxChars) || 4000)));
  if (endChar < total) {
    const nextBreak = anchored.indexOf("\n", endChar);
    // Stop at the next line break, but never blow far past the requested size.
    if (nextBreak !== -1 && nextBreak - endChar < 200) endChar = nextBreak + 1;
  }
  const text = anchored.slice(offset, endChar);

  // Where this slice sits in the video, so a caller can jump to it.
  // Precompute each rendered line's start offset once, then binary-search.
  const offsets = [];
  let cursor = 0;
  for (const line of subtitle.lines) {
    offsets.push({ start: cursor, at: Math.round(line.at) });
    cursor += withAnchors([line]).length + 1;
  }
  const atSecond = (index) => {
    if (offsets.length === 0) return 0;
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (offsets[mid].start <= index) low = mid;
      else high = mid - 1;
    }
    return offsets[low].at;
  };
  const startSeconds = atSecond(offset);
  const endSeconds = atSecond(Math.max(0, endChar - 1));

  return {
    aid: detail.aid,
    cid,
    bvid: detail.bvid,
    page: target?.page ?? 1,
    pageTitle: target?.title ?? detail.title,
    language: chosen.lan,
    languageLabel: chosen.lanDoc,
    isAiGenerated: chosen.aiType > 0,
    cues: subtitle.cues,
    durationSeconds: Math.round(subtitle.durationSeconds),
    characters: text.length,
    totalCharacters: total,
    startChar: offset,
    endChar,
    startSeconds,
    endSeconds,
    hasMore: endChar < total,
    truncated: endChar < total,
    text,
    availableTracks: tracks.map((track) => ({ lan: track.lan, label: track.lanDoc, ai: track.aiType > 0 })),
  };
}

/**
 * Fetch bilibili's own AI summary for a video, on the authenticated channel.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {object} detail - result of `videoDetail`.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<object>} the summary.
 */
export async function aiSummary(client, detail, signal) {
  if (!client.hasCredential) {
    throw new BiliError(
      "BILIBILI_LOGIN_REQUIRED",
      "the AI video summary needs a logged-in caller. Run bili_login start to unlock it."
    );
  }
  let data;
  try {
    data = await client.requestWbi(
      "auth",
      "/x/web-interface/view/conclusion/get",
      {
        bvid: detail.bvid,
        cid: String(detail.cid),
        up_mid: String(detail.owner.mid),
      },
      { cacheTtlMs: 24 * 60 * 60 * 1000, signal }
    );
  } catch (error) {
    // Measured 2026-10: a level-2, non-real-name account gets -403 here even
    // though its login is valid and subtitles work. The gate is higher than
    // "logged in", so turn the raw refusal into an actionable route.
    if (error instanceof BiliError && error.code === "BILIBILI_FORBIDDEN") {
      throw new BiliError(
        "BILIBILI_SUMMARY_FORBIDDEN",
        "bilibili's AI summary is gated above a normal login (measured: a level-2 non-real-name account is refused, " +
          "while subtitles work on the same account). Use bili_transcript instead — the transcript carries more detail anyway."
      );
    }
    throw error;
  }
  const result = data?.model_result;
  if (result === undefined || result === null) {
    throw new BiliError("BILIBILI_SUMMARY_UNAVAILABLE", "this video has no AI summary");
  }
  const outline = Array.isArray(result.outline)
    ? result.outline.map((section) => ({
        title: String(section?.title ?? ""),
        points: (Array.isArray(section?.part_outline) ? section.part_outline : []).map((part) => ({
          timestamp: Number(part?.timestamp ?? 0),
          content: String(part?.content ?? ""),
        })),
      }))
    : [];
  return {
    summary: String(result.summary ?? ""),
    outline,
    hasSummary: String(result.summary ?? "").length > 0,
  };
}
