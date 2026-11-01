// Load lib/client.js the way the DSH client bundle loader would, with a fake
// `window.__ModuleLoader__` and a fake `require('react')`, then assert the module
// registers the expected slots. Catches syntax errors, bad factory shape, and
// wrong exports before a restart is spent on them.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

/**
 * Evaluate the client bundle against a stub loader.
 * @returns {{id: string, exports: object, rendered: object[]}} what it registered.
 */
function loadClientBundle() {
  const registered = { id: null, exports: null };
  const rendered = [];

  // Minimal React stub: enough for module evaluation and slot registration.
  const React = {
    createElement(type, props, ...children) {
      const element = { type, props: props ?? {}, children };
      rendered.push(element);
      return element;
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useEffect() {},
    useRef(value) {
      return { current: value };
    },
    useCallback(fn) {
      return fn;
    },
    useSyncExternalStore(_sub, getSnapshot) {
      return getSnapshot();
    },
  };

  const fakeRequire = (name) => {
    if (name === "react") return React;
    throw new Error("unexpected require: " + name);
  };

  const windowStub = {
    __ModuleLoader__: {
      load(entry) {
        registered.id = entry.id;
        registered.exports = entry.factory(fakeRequire);
      },
    },
    __DSH_LOCALE__: {
      getSnapshot: () => ({ active: "zh-CN" }),
    },
  };

  const documentStub = {
    documentElement: { lang: "zh-CN" },
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, textContent: "" }),
  };

  // eslint-disable-next-line no-new-func
  const run = new Function("window", "document", "navigator", "setInterval", "clearInterval", SOURCE);
  run(windowStub, documentStub, { clipboard: { writeText() {} } }, () => 0, () => {});

  return { id: registered.id, exports: registered.exports, rendered };
}

test("the client bundle registers under the package id", () => {
  const { id } = loadClientBundle();
  assert.equal(id, "dsh-bilibili-retrieval");
});

test("the client bundle exports the loader contract", () => {
  const { exports } = loadClientBundle();
  assert.ok(Array.isArray(exports.inject), "inject must be an array");
  assert.equal(typeof exports.apply, "function", "apply must be a function");
});

test("apply registers a settings section and a header chip", () => {
  const { exports } = loadClientBundle();
  const slots = [];
  const ctx = {
    slots: {
      inject(name, factory) {
        const dispose = factory();
        slots.push({ name, dispose });
      },
      register(meta, component) {
        assert.ok(meta.name, "a slot registration needs a name");
        assert.ok(meta.id, "a slot registration needs an id");
        assert.equal(typeof component, "function", "the component must be a function");
        return () => {};
      },
    },
  };
  exports.apply(ctx);
  const names = slots.map((entry) => entry.name);
  assert.ok(names.includes("settings.section"), "must mount into settings");
  assert.ok(names.includes("conversation.session.header.actions"), "must mount a header chip");
});

test("apply tolerates a context without slots", () => {
  // Headless or partial mounts must not throw.
  const { exports } = loadClientBundle();
  assert.doesNotThrow(() => exports.apply({}));
  assert.doesNotThrow(() => exports.apply(null));
});

test("i18n covers both languages and every key the panel uses", () => {
  const { exports } = loadClientBundle();
  const { I18N } = exports.__test;
  assert.deepEqual(Object.keys(I18N).sort(), ["en", "zh"]);
  const zhKeys = Object.keys(I18N.zh).sort();
  const enKeys = Object.keys(I18N.en).sort();
  assert.deepEqual(enKeys, zhKeys, "both languages must define the same keys");
  // Spot-check the labels the panel renders most.
  for (const key of ["sectionTitle", "scanTitle", "loggedIn", "notLoggedIn", "cacheTitle", "save"]) {
    assert.ok(I18N.zh[key], "zh missing " + key);
    assert.ok(I18N.en[key], "en missing " + key);
  }
});

test("humanBytes formats the cache sizes the panel shows", () => {
  const { exports } = loadClientBundle();
  const { humanBytes } = exports.__test;
  assert.equal(humanBytes(0), "0 B");
  assert.equal(humanBytes(512), "512 B");
  assert.equal(humanBytes(2048), "2 KB");
  assert.equal(humanBytes(5 * 1024 * 1024), "5.0 MB");
});

test("the QR image is rendered from the dataUrl field, not a file path", () => {
  // Regression guard for the whole point of the panel: a browser cannot read a
  // path the host wrote, so the image must arrive inline. The host builds the
  // data URL (see panel.test.js); the client must consume that field.
  assert.ok(/src:\s*qr\.dataUrl/.test(SOURCE), "the panel must render qr.dataUrl");
  assert.ok(!/src:\s*[^,\n]*\.png/.test(SOURCE), "the panel must not point <img> at a file path");
});
