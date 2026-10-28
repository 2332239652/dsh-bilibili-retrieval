// Offline tests for frame retention and transcript paging.
import assert from "node:assert/strict";
import { mkdtemp, readdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { clearFrames, frameCacheReport, pruneFrames } from "../lib/frames.js";

/** Create a temp directory with `count` fake sheets of `size` bytes each. */
async function makeSheets(count, size) {
  const dir = await mkdtemp(join(tmpdir(), "bili-frames-"));
  for (let i = 0; i < count; i += 1) {
    const path = join(dir, `sheet-${String(i).padStart(2, "0")}.jpg`);
    await writeFile(path, Buffer.alloc(size, i));
    // Space the mtimes so "newest first" is deterministic.
    await new Promise((r) => setTimeout(r, 6));
  }
  return dir;
}

test("pruneFrames enforces the file-count cap and keeps the newest", async () => {
  const dir = await makeSheets(6, 64);
  try {
    const result = await pruneFrames(dir, { framesMaxFiles: 3, framesMaxBytes: 0 });
    assert.equal(result.removed, 3, "three oldest sheets must go");
    const left = (await readdir(dir)).sort();
    assert.deepEqual(left, ["sheet-03.jpg", "sheet-04.jpg", "sheet-05.jpg"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pruneFrames enforces the byte budget", async () => {
  const dir = await makeSheets(5, 1000);
  try {
    // Budget fits two sheets.
    await pruneFrames(dir, { framesMaxFiles: 100, framesMaxBytes: 2500 });
    const left = await readdir(dir);
    assert.equal(left.length, 2, "only the newest two fit the byte budget");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pruneFrames always keeps the newest sheet, even over budget", async () => {
  const dir = await makeSheets(3, 5000);
  try {
    await pruneFrames(dir, { framesMaxFiles: 1, framesMaxBytes: 100 });
    const left = await readdir(dir);
    assert.equal(left.length, 1, "the sheet just written survives an impossible budget");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pruneFrames ignores non-jpg files and a missing directory", async () => {
  const dir = await makeSheets(2, 32);
  try {
    await writeFile(join(dir, "notes.txt"), "keep me");
    await pruneFrames(dir, { framesMaxFiles: 1, framesMaxBytes: 0 });
    const left = await readdir(dir);
    assert.ok(left.includes("notes.txt"), "unrelated files are never deleted");
    assert.equal(left.filter((n) => n.endsWith(".jpg")).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const missing = await pruneFrames("", {});
  assert.deepEqual(missing, { removed: 0, freedBytes: 0 });
});

test("clearFrames removes every sheet and reports the space freed", async () => {
  const dir = await makeSheets(4, 256);
  try {
    const result = await clearFrames(dir);
    assert.equal(result.removed, 4);
    assert.equal(result.freedBytes, 1024);
    assert.equal((await readdir(dir)).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("frameCacheReport finds a stale directory from an older version", async () => {
  // Regression: an earlier build wrote sheets under profiles/desktop/bili-frames
  // because it used process.cwd(); that directory kept consuming space after the
  // bug was fixed. The report must surface it.
  const home = await mkdtemp(join(tmpdir(), "bili-home-"));
  const stale = join(home, "profiles", "desktop", "bili-frames");
  const current = join(home, "bili", "frames");
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    await (await import("node:fs/promises")).mkdir(stale, { recursive: true });
    await (await import("node:fs/promises")).mkdir(current, { recursive: true });
    await writeFile(join(stale, "old.jpg"), Buffer.alloc(512));
    await writeFile(join(current, "new.jpg"), Buffer.alloc(256));

    const rows = await frameCacheReport({});
    const dirs = rows.map((row) => row.dir);
    assert.ok(dirs.some((d) => d.includes(join("profiles", "desktop"))), "stale dir must be reported");
    assert.ok(dirs.some((d) => d === current), "current dir must be reported");
  } finally {
    process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("frameCacheReport scans the given workspace, not process.cwd()", async () => {
  // Regression: the first report scanned process.cwd() while writes went to the
  // session workspace, so it claimed "nothing on disk" with a 472 KB sheet
  // sitting in the workspace.
  const workspace = await mkdtemp(join(tmpdir(), "bili-ws-"));
  const home = await mkdtemp(join(tmpdir(), "bili-home2-"));
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.DSH_HOME = home;
    const frameDir = join(workspace, "bili-frames");
    await (await import("node:fs/promises")).mkdir(frameDir, { recursive: true });
    await writeFile(join(frameDir, "sheet.jpg"), Buffer.alloc(4096));

    const rows = await frameCacheReport({}, workspace);
    assert.equal(rows.length, 1, "exactly one location has sheets");
    assert.equal(rows[0].files, 1);
    assert.equal(rows[0].bytes, 4096);
    assert.equal(rows[0].dir, frameDir);
  } finally {
    process.env.DSH_HOME = previousHome;
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
