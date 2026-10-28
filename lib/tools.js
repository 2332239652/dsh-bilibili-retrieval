/**
 * The model-facing tools. Each one is a thin shape over the shared client:
 * fetch, normalize, return a structured value, and render a compact text form.
 *
 * Every tool declares plain JSON Schema for `parameters` and `output.schema`,
 * because this plugin registers through `ctx.tools.register()` without importing
 * `@deepseek-ai/dsh-tools` (see index.js for why).
 */

import { BiliError } from "./protocol.js";

/** Strip bilibili's `<em class="keyword">` highlight markup and entities. */
export function plainText(value) {
  return String(value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/**
 * Convert a play count to a compact human string.
 * @param {unknown} value - raw counter.
 * @returns {string} e.g. `1.2万`.
 */
export function humanCount(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 100000000) return (n / 100000000).toFixed(1).replace(/\.0$/, "") + "亿";
  if (n >= 10000) return (n / 10000).toFixed(1).replace(/\.0$/, "") + "万";
  return String(n);
}

/**
 * Convert a bilibili duration (seconds or `mm:ss` / `hh:mm:ss`) to seconds.
 * @param {unknown} value - raw duration.
 * @returns {number} seconds, or 0 when unreadable.
 */
export function durationSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  const raw = String(value ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

/**
 * Format seconds as `hh:mm:ss` / `mm:ss`.
 * @param {number} total - seconds.
 * @returns {string} formatted duration.
 */
export function formatDuration(total) {
  const seconds = Math.max(0, Math.trunc(Number(total) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : m + ":" + pad(s);
}

/** Absolute URL for a video id. */
export function videoUrl(bvid) {
  return "https://www.bilibili.com/video/" + String(bvid ?? "");
}

/**
 * Map one raw search item to the declared video shape.
 * @param {any} item - one `data.result[].data[]` entry.
 * @returns {object} normalized video.
 */
function mapSearchItem(item) {
  const bvid = String(item?.bvid ?? "");
  const seconds = durationSeconds(item?.duration);
  return {
    bvid,
    title: plainText(item?.title),
    author: String(item?.author ?? ""),
    mid: Number(item?.mid ?? 0),
    play: Number(item?.play ?? 0),
    danmaku: Number(item?.video_review ?? 0),
    favorites: Number(item?.favorites ?? 0),
    like: Number(item?.like ?? 0),
    durationSeconds: seconds,
    publishedAt: Number(item?.pubdate ?? 0),
    description: plainText(item?.description).slice(0, 400),
    tag: plainText(item?.tag),
    url: videoUrl(bvid),
  };
}

/**
 * Split a query into the tokens worth matching on.
 *
 * Latin/digit runs match as whole words; CJK runs are kept as-is because there
 * is no word segmenter here and substring matching is the right approximation
 * for Chinese titles.
 *
 * @param {string} keyword - raw query.
 * @returns {string[]} lowercased tokens, longest first.
 */
export function queryTokens(keyword) {
  const raw = String(keyword ?? "").toLowerCase();
  const tokens = raw.match(/[a-z0-9][a-z0-9+#.]*|\p{Script=Han}+/gu) ?? [];
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    // Strip a trailing sentence dot ("node.js." → "node.js") but keep "++" and
    // "#": C++ and C# are real technology names, not punctuation.
    const trimmed = token.replace(/\.+$/, "");
    if (trimmed.length < 2) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out.sort((a, b) => b.length - a.length);
}

/**
 * Count how many query tokens a haystack contains.
 *
 * Latin tokens must match on a word boundary, because substring matching lets a
 * real word through from an unrelated title: "hooks" appears inside "Sky Hooks"
 * (a jazz track returned for the query "react hooks"), and "rust" appears inside
 * "Rust 主界面设置" (a game, not the language). CJK tokens match as substrings —
 * there is no segmenter here, and Chinese titles have no spaces to delimit on.
 *
 * @param {string} haystack - lowercased title + tags + description.
 * @param {string[]} tokens - from {@link queryTokens}.
 * @returns {number} matched token count.
 */
export function matchScore(haystack, tokens) {
  let score = 0;
  for (const token of tokens) {
    // A CJK token contains no ASCII letters or digits.
    if (!/[a-z0-9]/.test(token)) {
      if (haystack.includes(token)) score += 1;
      continue;
    }
    // Latin/digit token: require a boundary on both sides so "hooks" does not
    // match "skyhooks" and "k8s" does not match "k8stest". Escaped because a
    // token can carry regex-significant characters (c++, node.js).
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp("(^|[^a-z0-9])" + escaped + "($|[^a-z0-9])", "i").test(haystack)) score += 1;
  }
  return score;
}

/**
 * Anonymous keyword search over `search/all/v2`.
 *
 * This is the main channel: in the feasibility probe it answered 20+
 * consecutive requests, while `wbi/search/type` returned a `v_voucher`
 * challenge on request 7 and the unsigned `search/type` returned HTTP 412 on
 * request 2.
 *
 * Bilibili's own recall is loose — it matches token *fragments*, so "k8s 入门"
 * surfaces a Torchlight video titled "…k8小时500火" and "react hooks" surfaces a
 * song called "Sky Hooks". Left alone, that noise costs the caller real
 * attention: an early subagent reported having to hand-filter every result set.
 * Results that share no query token at all are therefore dropped, and partial
 * matches sink below full matches. `strict` keeps only full matches.
 *
 * @param {object} params - search parameters.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<{videos: object[], filtered: number, requested: number}>} videos plus filter accounting.
 */
export async function searchVideos({ keyword, limit, strict = false }, client, signal) {
  const data = await client.requestJson(
    "anonymous",
    "https://api.bilibili.com/x/web-interface/search/all/v2?keyword=" +
      encodeURIComponent(keyword) +
      "&page=1",
    { cacheTtlMs: 10 * 60 * 1000, signal }
  );
  const sections = Array.isArray(data?.result) ? data.result : [];
  const videoSection = sections.find((section) => section?.result_type === "video");
  const items = Array.isArray(videoSection?.data) ? videoSection.data : [];
  const mapped = items.map(mapSearchItem);

  const tokens = queryTokens(keyword);
  if (tokens.length === 0) {
    return { videos: mapped.slice(0, limit), filtered: 0, requested: mapped.length, unfiltered: false };
  }

  const scored = mapped.map((video) => {
    const haystack = (video.title + " " + video.tag + " " + video.description).toLowerCase();
    return { video, score: matchScore(haystack, tokens) };
  });

  // How hard to filter depends on whether the query can be matched literally.
  //
  // All-latin queries are matched *fully*: every token must appear as a word, so
  // "react hooks" rejects a jazz track called "Sky Hooks" (it matches "hooks"
  // but not "react"). Latin titles are word-delimited, so this is safe.
  //
  // Queries containing Chinese cannot use that rule: aliases are everywhere
  // ("k8s" vs "Kubernetes"), and the single best tutorial for "k8s 入门" only
  // says "Kubernetes…入门". There, any token match is enough and the score only
  // decides ranking.
  const allLatin = tokens.every((token) => /[a-z0-9]/.test(token));
  const required = allLatin ? tokens.length : 1;
  let kept = scored.filter((entry) => entry.score >= required);

  // Safety net: a query whose intent lives in an alias can match nothing
  // literally. Returning an empty list would be worse than bilibili's own order,
  // so fall back to it and say so.
  if (kept.length === 0) {
    return {
      videos: mapped.slice(0, limit),
      filtered: 0,
      requested: mapped.length,
      unfiltered: true,
    };
  }

  // When the query is well served — at least a few results match every token —
  // the partial matches are noise, not choices: "Python 异步" should not offer a
  // "Python For循环语句" video just because it says "Python". The minimum of
  // three keeps this from over-firing on a query where nothing matches fully.
  const fullMatches = kept.filter((entry) => entry.score === tokens.length);
  if (fullMatches.length >= 3) kept = fullMatches;
  if (strict) kept = fullMatches.length > 0 ? fullMatches : kept;

  // Filter only — do not re-rank. Bilibili's own order already folds in
  // engagement and freshness, and re-sorting by token count demoted a clearly
  // better 61-minute tutorial below a 7-hour one purely because its title says
  // "Kubernetes" instead of "k8s". Removing noise is the job here; judging
  // quality is not.
  const ordered = kept;

  return {
    videos: ordered.slice(0, limit).map((entry) => entry.video),
    filtered: mapped.length - ordered.length,
    requested: mapped.length,
    unfiltered: false,
  };
}

/**
 * Full metadata for one video via `view/detail`, which returns View, Tags,
 * Related and the reply summary in a single request — one request instead of
 * four, which matters under risk control.
 *
 * @param {{bvid: string} | {aid: number}} ref - parsed video reference.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<object>} normalized detail.
 */
export async function videoDetail(ref, client, signal, options = {}) {
  // Related videos are opt-in. They are 20 entries of noise on most calls, and
  // the caller can ask for them explicitly when exploring a topic.
  const relatedCount = Math.max(0, Math.min(20, Math.trunc(Number(options.related ?? 0) || 0)));
  const query = ref.bvid !== undefined ? "bvid=" + ref.bvid : "aid=" + ref.aid;
  const data = await client.requestJson(
    "anonymous",
    "https://api.bilibili.com/x/web-interface/view/detail?" + query,
    { cacheTtlMs: 24 * 60 * 60 * 1000, signal }
  );
  const view = data?.View;
  if (view === undefined || view === null) {
    throw new BiliError("BILIBILI_BAD_RESPONSE", "view/detail returned no View object");
  }
  const pages = Array.isArray(view.pages) ? view.pages : [];
  return {
    bvid: String(view.bvid ?? ""),
    aid: Number(view.aid ?? 0),
    cid: Number(view.cid ?? 0),
    title: plainText(view.title),
    // desc_v2 keeps the author's original line breaks; desc collapses them.
    description: plainText(Array.isArray(view.desc_v2) && view.desc_v2.length > 0
      ? view.desc_v2.map((part) => part?.raw_text ?? "").join("\n")
      : view.desc),
    owner: {
      mid: Number(view.owner?.mid ?? 0),
      name: String(view.owner?.name ?? ""),
    },
    stat: {
      view: Number(view.stat?.view ?? 0),
      danmaku: Number(view.stat?.danmaku ?? 0),
      reply: Number(view.stat?.reply ?? 0),
      favorite: Number(view.stat?.favorite ?? 0),
      coin: Number(view.stat?.coin ?? 0),
      share: Number(view.stat?.share ?? 0),
      like: Number(view.stat?.like ?? 0),
    },
    durationSeconds: Number(view.duration ?? 0),
    publishedAt: Number(view.pubdate ?? 0),
    cover: String(view.pic ?? ""),
    pages: pages.map((page) => ({
      page: Number(page?.page ?? 0),
      cid: Number(page?.cid ?? 0),
      title: plainText(page?.part),
      durationSeconds: Number(page?.duration ?? 0),
    })),
    tags: (Array.isArray(data?.Tags) ? data.Tags : []).map((tag) => String(tag?.tag_name ?? "")).filter((name) => name.length > 0),
    related: (Array.isArray(data?.Related) ? data.Related : []).slice(0, relatedCount).map((item) => ({
      bvid: String(item?.bvid ?? ""),
      title: plainText(item?.title),
      author: String(item?.owner?.name ?? ""),
      play: Number(item?.stat?.view ?? 0),
      url: videoUrl(item?.bvid),
    })),
    url: videoUrl(view.bvid),
  };
}

/**
 * Comments for one video: the creator's pinned comment, plus hot replies.
 *
 * The pinned comment is the highest-density field on most tutorial videos —
 * creators put the repo link, the dataset, or the "read this first" caveat
 * there. Note this uses `reply/main`, not `reply/wbi/main`: the WBI variant
 * answers -403 anonymously.
 *
 * @param {object} params - request parameters.
 * @param {{bvid: string} | {aid: number}} params.ref - parsed video reference.
 * @param {number} params.limit - how many top-level comments to return.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<object>} pinned + hot comments.
 */
export async function videoComments({ ref, limit }, client, signal) {
  const aid = await resolveAid(ref, client, signal);
  const data = await client.requestJson(
    "anonymous",
    "https://api.bilibili.com/x/v2/reply/main?next=0&type=1&oid=" + aid + "&mode=3",
    { cacheTtlMs: 60 * 60 * 1000, signal }
  );

  const mapReply = (reply) => ({
    user: String(reply?.member?.uname ?? ""),
    mid: Number(reply?.member?.mid ?? 0),
    like: Number(reply?.like ?? 0),
    replyCount: Number(reply?.rcount ?? 0),
    text: plainText(reply?.content?.message),
    createdAt: Number(reply?.ctime ?? 0),
  });

  const pinnedUpper = data?.top?.upper;
  const pinned = pinnedUpper !== undefined && pinnedUpper !== null && pinnedUpper?.content !== undefined
    ? mapReply(pinnedUpper)
    : null;

  const topReplies = (Array.isArray(data?.top_replies) ? data.top_replies : []).map(mapReply);
  const hot = (Array.isArray(data?.replies) ? data.replies : []).slice(0, limit).map(mapReply);

  // `top_replies` normally repeats the pinned comment verbatim, so echoing both
  // spends the reader's attention twice on the same text.
  const distinctTop = topReplies.filter(
    (reply) => pinned === null || reply.text !== pinned.text || reply.user !== pinned.user
  );

  // `reply/main` returns ONE page of roughly 20 top-level comments, and the
  // pinned comment is normally the only place a creator leaves a resource link.
  // A caller hunting for that link had no way to tell "this video has no link"
  // from "the comment is further down", so an early subagent ended up scanning
  // dozens of videos by hand. Say which case applies.
  const hasPinned = pinned !== null;
  // Only report a link comment when it is NOT the pinned one — the pinned comment
  // is already rendered separately, and repeating it wastes the reader's time.
  const linkComment =
    [...distinctTop, ...hot].find((entry) => /https?:\/\/|www\./i.test(String(entry?.text ?? ""))) ?? null;

  return {
    aid,
    pinned,
    topReplies: distinctTop,
    hot,
    hasPinned,
    linkComment,
    // Only the first page was read; a resource link below it would not appear here.
    pageComplete: false,
    cursor: Number(data?.cursor?.next ?? 0),
    isEnd: Boolean(data?.cursor?.is_end),
  };
}

/**
 * Resolve an aid from a video reference, reusing the cached detail when the
 * caller already fetched it.
 * @param {{bvid?: string, aid?: number}} ref - parsed reference.
 * @param {import("./protocol.js").BiliClient} client - shared client.
 * @param {AbortSignal} [signal] - cooperative cancellation.
 * @returns {Promise<number>} the numeric aid.
 */
async function resolveAid(ref, client, signal) {
  if (ref.aid !== undefined) return ref.aid;
  const detail = await videoDetail(ref, client, signal);
  return detail.aid;
}

/** Human-readable render for search results. */
export function renderSearch(_args, value) {
  const lines = ["<bilibili_search count=\"" + value.videos.length + "\">"];
  for (const video of value.videos) {
    lines.push(
      "- [" + video.title.slice(0, 80) + "](" + video.url + ")\n" +
        "  " + video.author + " · " + humanCount(video.play) + "播放 · " +
        formatDuration(video.durationSeconds) + (video.publishedAt > 0 ? " · " + new Date(video.publishedAt * 1000).toISOString().slice(0, 10) : "")
    );
  }
  // Say what was dropped, so a caller can tell "few results" from "noisy query".
  if (Number(value.filtered) > 0) {
    lines.push(
      "<filtered out=\"" + value.filtered + "\" of=\"" + value.requested +
        "\">bilibili's recall is loose; results that did not match the query closely enough were dropped</filtered>"
    );
  }
  if (value.unfiltered === true) {
    lines.push(
      "<note>nothing matched the query literally, so these are bilibili's own ranking — the intent may be an alias or a different spelling</note>"
    );
  }
  lines.push("</bilibili_search>");
  return [{ type: "text", text: lines.join("\n") }];
}

/** Human-readable render for video detail. */
export function renderVideo(_args, value) {
  const lines = [
    "<bilibili_video>",
    "<title>" + value.title + "</title>",
    "<url>" + value.url + "</url>",
    "<owner mid=\"" + value.owner.mid + "\">" + value.owner.name + "</owner>",
    "<stats view=\"" + value.stat.view + "\" like=\"" + value.stat.like + "\" favorite=\"" + value.stat.favorite +
      "\" coin=\"" + value.stat.coin + "\" reply=\"" + value.stat.reply + "\" danmaku=\"" + value.stat.danmaku + "\"/>",
    "<duration>" + formatDuration(value.durationSeconds) + "</duration>",
    "<published>" + (value.publishedAt > 0 ? new Date(value.publishedAt * 1000).toISOString().slice(0, 10) : "unknown") + "</published>",
  ];
  if (value.description.length > 0) {
    lines.push("<description>", value.description, "</description>");
  }
  if (value.tags.length > 0) lines.push("<tags>" + value.tags.join(", ") + "</tags>");
  if (value.pages.length > 1) {
    lines.push("<parts count=\"" + value.pages.length + "\">");
    for (const page of value.pages.slice(0, 30)) {
      lines.push("  P" + page.page + " " + page.title + " (" + formatDuration(page.durationSeconds) + ")");
    }
    if (value.pages.length > 30) lines.push("  … " + (value.pages.length - 30) + " more");
    lines.push("</parts>");
  }
  if (value.related.length > 0) {
    lines.push("<related>");
    for (const item of value.related.slice(0, 10)) {
      lines.push("  - [" + item.title.slice(0, 60) + "](" + item.url + ") · " + humanCount(item.play));
    }
    lines.push("</related>");
  }
  lines.push("</bilibili_video>");
  return [{ type: "text", text: lines.join("\n") }];
}

/** Human-readable render for comments. */
export function renderComments(_args, value) {
  const lines = ["<bilibili_comments aid=\"" + value.aid + "\">"];
  // State whether a pinned comment exists at all. Without this, "no pinned
  // comment" and "pinned comment not on this page" look identical, and a caller
  // hunting a resource link has no way to stop scanning.
  lines.push("<has_pinned>" + (value.hasPinned ? "true" : "false") + "</has_pinned>");
  if (value.pinned !== null) {
    lines.push(
      "<pinned by=\"creator\" user=\"" + value.pinned.user + "\" likes=\"" + value.pinned.like + "\">",
      value.pinned.text,
      "</pinned>"
    );
  }
  // Compare by content, not identity: the value passes through schema validation
  // before rendering, which clones it, so `linkComment === pinned` never holds
  // even when both point at the same comment.
  const sameAsPinned =
    value.pinned !== null &&
    value.pinned !== undefined &&
    value.linkComment !== null &&
    value.linkComment !== undefined &&
    value.linkComment.user === value.pinned.user &&
    value.linkComment.text === value.pinned.text;
  if (value.linkComment !== null && value.linkComment !== undefined && !sameAsPinned) {
    // A URL buried in the hot replies still answers "where is the resource link".
    lines.push("<link_in_comments user=\"" + value.linkComment.user + "\">" + value.linkComment.text.slice(0, 300) + "</link_in_comments>");
  }
  if (value.topReplies.length > 0) {
    lines.push("<top_replies>");
    for (const reply of value.topReplies) {
      lines.push("  - " + reply.user + " (" + humanCount(reply.like) + "赞): " + reply.text.slice(0, 300));
    }
    lines.push("</top_replies>");
  }
  if (value.hot.length > 0) {
    lines.push("<hot>");
    for (const reply of value.hot) {
      lines.push(
        "  - " + reply.user + " (" + humanCount(reply.like) + "赞, " + reply.replyCount + "回复): " + reply.text.slice(0, 300)
      );
    }
    lines.push("</hot>");
  }
  lines.push("<scope>first page of top-level comments only; a link further down would not appear here</scope>");
  lines.push("</bilibili_comments>");
  return [{ type: "text", text: lines.join("\n") }];
}
