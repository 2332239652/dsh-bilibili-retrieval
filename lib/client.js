/**
 * Browser half of dsh-bilibili-retrieval: the control panel.
 *
 * Two entry points, both inside the DSH settings dialog:
 *
 *  - `settings.section` — full panel: login (with the QR rendered inline, no
 *    file path to hunt down), account state, frame-cache footprint, and the
 *    rate-limit / retention knobs.
 *  - `conversation.session.header.actions` — a small chip showing whether the
 *    authenticated channel is live, so the state is visible without opening
 *    settings.
 *
 * Everything privileged happens on the host through `/api/bilibili-retrieval`;
 * this file only renders and polls. The QR arrives as a data URL because a
 * browser cannot read a file path the host wrote.
 *
 * Loaded by the DSH client bundle loader, which is why this is a
 * `window.__ModuleLoader__.load` wrapper rather than an ES module: the loader
 * provides `require('react')` and expects `{ inject, apply }`.
 */

window.__ModuleLoader__.load({
  id: "dsh-bilibili-retrieval",
  factory: function (require) {
    "use strict";

    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var API = "/api/bilibili-retrieval";
    var PLUGIN_ID = "dsh-bilibili-retrieval";
    var STYLE_ID = "dsh-bilibili-retrieval-styles";

    // ---------------------------------------------------------------- i18n

    var I18N = {
      zh: {
        sectionTitle: "B 站检索",
        sectionSubtitle: "扫码解锁字幕；搜索、评论、抽帧无需登录",
        loginTitle: "账号",
        notLoggedIn: "未登录",
        notLoggedInHint: "字幕与 AI 摘要需要登录。搜索、视频详情、评论、抽帧匿名即可用。",
        loggedIn: "已登录",
        loginInvalid: "凭据已失效，请重新扫码",
        scanTitle: "扫码登录",
        scanHint: "用手机 B 站 App 扫描下方二维码，并在手机上确认。",
        scanWaiting: "等待扫码",
        scanScanned: "已扫码，请在手机上确认",
        scanExpired: "二维码已过期",
        scanSuccess: "登录成功",
        scanExpiredHint: "二维码 3 分钟过期。重新生成即可。",
        regenerate: "重新生成",
        refreshQr: "刷新状态",
        logout: "退出登录",
        loading: "加载中…",
        channelTitle: "通道",
        anonymous: "匿名通道",
        authenticated: "登录通道",
        ready: "就绪",
        notReady: "未启用",
        cacheTitle: "预览图缓存",
        cacheFiles: "文件",
        cacheSize: "占用",
        cacheClear: "清空",
        cacheCleared: "已清空",
        cacheEmpty: "暂无缓存",
        configTitle: "参数",
        anonInterval: "匿名请求间隔 (ms)",
        anonBurst: "匿名桶深",
        authInterval: "登录请求间隔 (ms)",
        authBurst: "登录桶深",
        authCap: "登录通道单会话上限",
        framesMaxFiles: "预览图保留张数",
        framesMaxMB: "预览图上限 (MB)",
        save: "保存",
        saved: "已保存",
        reset: "恢复默认",
        error: "出错了",
        retry: "重试",
        copyUrl: "复制链接",
        copied: "已复制",
        openUrl: "在新标签打开",
        qrAlt: "B 站登录二维码",
      },
      en: {
        sectionTitle: "Bilibili Retrieval",
        sectionSubtitle: "Scan to unlock subtitles; search, comments and frames need no login",
        loginTitle: "Account",
        notLoggedIn: "Not signed in",
        notLoggedInHint: "Subtitles and the AI summary need a login. Search, video detail, comments and frames work anonymously.",
        loggedIn: "Signed in",
        loginInvalid: "Credential expired — scan again",
        scanTitle: "Sign in by QR",
        scanHint: "Scan this code with the Bilibili app on your phone, then confirm there.",
        scanWaiting: "Waiting for scan",
        scanScanned: "Scanned — confirm on your phone",
        scanExpired: "QR expired",
        scanSuccess: "Signed in",
        scanExpiredHint: "A QR lives for 3 minutes. Generate a fresh one.",
        regenerate: "Regenerate",
        refreshQr: "Refresh",
        logout: "Sign out",
        loading: "Loading…",
        channelTitle: "Channels",
        anonymous: "Anonymous",
        authenticated: "Authenticated",
        ready: "ready",
        notReady: "off",
        cacheTitle: "Frame cache",
        cacheFiles: "files",
        cacheSize: "size",
        cacheClear: "Clear",
        cacheCleared: "Cleared",
        cacheEmpty: "Nothing cached",
        configTitle: "Parameters",
        anonInterval: "Anonymous interval (ms)",
        anonBurst: "Anonymous burst",
        authInterval: "Auth interval (ms)",
        authBurst: "Auth burst",
        authCap: "Auth cap per session",
        framesMaxFiles: "Frame files kept",
        framesMaxMB: "Frame cap (MB)",
        save: "Save",
        saved: "Saved",
        reset: "Reset",
        error: "Something went wrong",
        retry: "Retry",
        copyUrl: "Copy link",
        copied: "Copied",
        openUrl: "Open in a new tab",
        qrAlt: "Bilibili login QR",
      },
    };

    /**
     * Pick a language from the client locale service, falling back to the
     * document language and then to Chinese.
     * @returns {"zh"|"en"} language key.
     */
    function currentLang() {
      try {
        var snap = window.__DSH_LOCALE__ && window.__DSH_LOCALE__.getSnapshot
          ? window.__DSH_LOCALE__.getSnapshot()
          : null;
        if (snap && typeof snap.active === "string") {
          return snap.active.toLowerCase().indexOf("zh") === 0 ? "zh" : "en";
        }
      } catch {
        // Fall through to the document language.
      }
      var tag = document.documentElement && document.documentElement.lang;
      if (typeof tag === "string" && tag.toLowerCase().indexOf("zh") === 0) return "zh";
      return tag ? "en" : "zh";
    }

    /**
     * Translate a key for the active language.
     * @param {string} key - message key.
     * @returns {string} localized text, or the key when missing.
     */
    function t(key) {
      var lang = currentLang();
      var table = I18N[lang] || I18N.zh;
      return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : key;
    }

    // ---------------------------------------------------------------- styles

    /**
     * Inject the panel stylesheet once, tagged so HMR can replace it.
     * @returns {void}
     */
    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.setAttribute("data-plugin", PLUGIN_ID);
      style.textContent = [
        ".dbr-root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}",
        ".dbr-card{border:1px solid var(--dsh-border, rgba(127,127,127,.22));border-radius:10px;padding:12px 14px}",
        ".dbr-card h4{margin:0 0 8px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}",
        ".dbr-muted{opacity:.66}",
        ".dbr-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 0}",
        ".dbr-row+.dbr-row{border-top:1px dashed var(--dsh-border, rgba(127,127,127,.16))}",
        ".dbr-badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}",
        ".dbr-ok{color:#10b981}",
        ".dbr-off{color:#9ca3af}",
        ".dbr-warn{color:#f59e0b}",
        ".dbr-btn{font:inherit;font-size:12px;padding:4px 12px;border-radius:7px;cursor:pointer;border:1px solid var(--dsh-border, rgba(127,127,127,.3));background:transparent;color:inherit}",
        ".dbr-btn:hover:not(:disabled){background:rgba(127,127,127,.1)}",
        ".dbr-btn:disabled{opacity:.45;cursor:default}",
        ".dbr-btn-primary{border-color:#00a1d6;color:#00a1d6;font-weight:600}",
        ".dbr-btn-primary:hover:not(:disabled){background:rgba(0,161,214,.1)}",
        ".dbr-qr{display:flex;flex-direction:column;align-items:center;gap:10px;padding:8px 0}",
        ".dbr-qr img{width:200px;height:200px;image-rendering:pixelated;border-radius:8px;background:#fff;padding:8px}",
        ".dbr-qr-state{font-size:12px}",
        ".dbr-input{font:inherit;font-size:12px;width:88px;padding:3px 8px;border-radius:6px;border:1px solid var(--dsh-border, rgba(127,127,127,.3));background:transparent;color:inherit;text-align:right}",
        ".dbr-link{font-size:11px;word-break:break-all;opacity:.6;max-width:100%}",
        ".dbr-chip{display:inline-flex;align-items:center;gap:5px;font-size:12px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsh-border, rgba(127,127,127,.28));background:transparent;color:inherit;cursor:pointer}",
        ".dbr-chip:hover{background:rgba(127,127,127,.1)}",
        ".dbr-dot{width:7px;height:7px;border-radius:50%;display:inline-block}",
        ".dbr-err{color:#ef4444;font-size:12px}",
      ].join("\n");
      document.head.appendChild(style);
    }

    // ------------------------------------------------------------------ api

    /**
     * GET a JSON endpoint on the host.
     * @param {string} path - path after the API prefix.
     * @returns {Promise<object>} parsed body.
     */
    async function apiGet(path) {
      var res = await fetch(API + path, { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }

    /**
     * POST a JSON body to a host endpoint.
     * @param {string} path - path after the API prefix.
     * @param {object} body - payload.
     * @returns {Promise<object>} parsed body.
     */
    async function apiPost(path, body) {
      var res = await fetch(API + path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }

    /**
     * Format a byte count.
     * @param {number} bytes - byte count.
     * @returns {string} human-readable size.
     */
    function humanBytes(bytes) {
      var n = Number(bytes) || 0;
      if (n < 1024) return n + " B";
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
      return (n / 1024 / 1024).toFixed(1) + " MB";
    }

    // ------------------------------------------------------------ components

    /**
     * A labelled numeric input bound to one config key.
     * @param {object} props - component props.
     * @returns {object} React element.
     */
    function NumberField(props) {
      return React.createElement(
        "div",
        { className: "dbr-row" },
        React.createElement("span", { className: "dbr-muted" }, props.label),
        React.createElement("input", {
          className: "dbr-input",
          type: "number",
          min: 0,
          value: props.value,
          disabled: props.disabled,
          onChange: function (event) {
            props.onChange(Number(event.target.value));
          },
        })
      );
    }

    /**
     * The full control panel.
     * @returns {object} React element.
     */
    function Panel() {
      var [status, setStatus] = React.useState(null);
      var [qr, setQr] = React.useState(null);
      var [busy, setBusy] = React.useState("");
      var [error, setError] = React.useState("");
      var [draft, setDraft] = React.useState(null);
      var [notice, setNotice] = React.useState("");
      var pollRef = React.useRef(null);

      var stopPolling = React.useCallback(function () {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      }, []);

      var load = React.useCallback(
        async function () {
          try {
            var next = await apiGet("/status");
            setStatus(next);
            setDraft(next.config);
            if (next.pending) {
              setQr(next.pending);
            }
            setError("");
          } catch (e) {
            setError(String(e.message || e));
          }
        },
        []
      );

      React.useEffect(function () {
        load();
        return stopPolling;
      }, [load, stopPolling]);

      /**
       * Poll the pending QR until it resolves.
       * @returns {void}
       */
      var startPolling = React.useCallback(
        function () {
          stopPolling();
          pollRef.current = setInterval(async function () {
            try {
              var res = await apiGet("/qr");
              if (res.qr) {
                setQr(res.qr);
                if (res.qr.state === "expired") {
                  stopPolling();
                }
              }
              if (res.loggedIn) {
                stopPolling();
                setQr(null);
                setNotice(t("scanSuccess"));
                await load();
              }
            } catch {
              // Transient; the next tick retries.
            }
          }, 2000);
        },
        [load, stopPolling]
      );

      /**
       * Mint a fresh QR and begin polling.
       * @returns {Promise<void>}
       */
      var generateQr = React.useCallback(
        async function () {
          stopPolling();
          setBusy("qr");
          setError("");
          setNotice("");
          try {
            var res = await apiPost("/qr", {});
            if (res.ok && res.qr) {
              setQr(res.qr);
              startPolling();
            } else {
              setError(String(res.error || t("error")));
            }
          } catch (e) {
            setError(String(e.message || e));
          } finally {
            setBusy("");
          }
        },
        [startPolling, stopPolling]
      );

      /**
       * Forget the saved credential.
       * @returns {Promise<void>}
       */
      var logout = React.useCallback(async function () {
        setBusy("logout");
        try {
          var res = await apiPost("/logout", {});
          if (res.status) {
            setStatus(res.status);
            setDraft(res.status.config);
          }
          setQr(null);
          stopPolling();
          setNotice("");
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy("");
        }
      }, [stopPolling]);

      /**
       * Clear every cached frame sheet.
       * @returns {Promise<void>}
       */
      var clearCache = React.useCallback(async function () {
        setBusy("cache");
        try {
          var res = await apiPost("/cache", { action: "clear" });
          if (res.status) setStatus(res.status);
          setNotice(t("cacheCleared") + " · " + humanBytes(res.freedBytes || 0));
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy("");
        }
      }, []);

      /**
       * Persist the edited numeric parameters.
       * @returns {Promise<void>}
       */
      var saveConfig = React.useCallback(async function () {
        if (draft === null) return;
        setBusy("config");
        try {
          var res = await apiPost("/config", {
            anonMinIntervalMs: draft.anonMinIntervalMs,
            anonBurst: draft.anonBurst,
            authMinIntervalMs: draft.authMinIntervalMs,
            authBurst: draft.authBurst,
            authMaxPerSession: draft.authMaxPerSession,
            framesMaxFiles: draft.framesMaxFiles,
            framesMaxBytes: Math.round(Number(draft.framesMaxBytes) / (1024 * 1024)) * 1024 * 1024,
          });
          if (res.ok) {
            setNotice(t("saved"));
            await load();
          } else {
            setError(String(res.error || t("error")));
          }
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          setBusy("");
        }
      }, [draft, load]);

      if (status === null) {
        return React.createElement(
          "div",
          { className: "dbr-root" },
          React.createElement("div", { className: "dbr-muted" }, error || t("loading"))
        );
      }

      var account = status.account;
      var signedIn = account !== null && account.valid === true;
      var cache = status.cache;

      var children = [];

      // ------------------------------------------------------------ header
      children.push(
        React.createElement(
          "div",
          { className: "dbr-card", key: "login" },
          React.createElement(
            "h4",
            null,
            t("loginTitle"),
            React.createElement(
              "span",
              { className: "dbr-badge " + (signedIn ? "dbr-ok" : "dbr-off") },
              signedIn ? t("loggedIn") : t("notLoggedIn")
            )
          ),
          signedIn
            ? React.createElement(
                "div",
                null,
                React.createElement(
                  "div",
                  { className: "dbr-row" },
                  React.createElement("span", { className: "dbr-muted" }, "UID"),
                  React.createElement("span", null, String(account.mid))
                ),
                React.createElement(
                  "div",
                  { className: "dbr-row" },
                  React.createElement("span", { className: "dbr-muted" }, "Nickname"),
                  React.createElement("span", null, String(account.name || "—"))
                ),
                React.createElement(
                  "div",
                  { className: "dbr-row" },
                  React.createElement("span", null),
                  React.createElement(
                    "button",
                    {
                      className: "dbr-btn",
                      type: "button",
                      disabled: busy === "logout",
                      onClick: logout,
                    },
                    t("logout")
                  )
                )
              )
            : React.createElement(
                "div",
                null,
                React.createElement("div", { className: "dbr-muted" }, t("notLoggedInHint")),
                qr === null
                  ? React.createElement(
                      "div",
                      { className: "dbr-row" },
                      React.createElement("span", null),
                      React.createElement(
                        "button",
                        {
                          className: "dbr-btn dbr-btn-primary",
                          type: "button",
                          disabled: busy === "qr",
                          onClick: generateQr,
                        },
                        busy === "qr" ? t("loading") : t("scanTitle")
                      )
                    )
                  : React.createElement(
                      "div",
                      { className: "dbr-qr" },
                      React.createElement("img", {
                        src: qr.dataUrl,
                        alt: t("qrAlt"),
                        width: 200,
                        height: 200,
                      }),
                      React.createElement(
                        "div",
                        { className: "dbr-qr-state " + (qr.state === "expired" ? "dbr-warn" : "") },
                        qr.state === "scanned"
                          ? t("scanScanned")
                          : qr.state === "expired"
                            ? t("scanExpired") + " · " + t("scanExpiredHint")
                            : t("scanWaiting")
                      ),
                      React.createElement(
                        "div",
                        { style: { display: "flex", gap: 8 } },
                        React.createElement(
                          "button",
                          {
                            className: "dbr-btn dbr-btn-primary",
                            type: "button",
                            disabled: busy === "qr",
                            onClick: generateQr,
                          },
                          qr.state === "expired" ? t("regenerate") : t("refreshQr")
                        ),
                        React.createElement(
                          "button",
                          {
                            className: "dbr-btn",
                            type: "button",
                            onClick: function () {
                              try {
                                navigator.clipboard.writeText(qr.url);
                                setNotice(t("copied"));
                              } catch {
                                setNotice(qr.url);
                              }
                            },
                          },
                          t("copyUrl")
                        )
                      ),
                      React.createElement("div", { className: "dbr-link" }, qr.url)
                    )
              )
        )
      );

      // ---------------------------------------------------------- channels
      children.push(
        React.createElement(
          "div",
          { className: "dbr-card", key: "channels" },
          React.createElement("h4", null, t("channelTitle")),
          React.createElement(
            "div",
            { className: "dbr-row" },
            React.createElement("span", { className: "dbr-muted" }, t("anonymous")),
            React.createElement(
              "span",
              { className: "dbr-ok" },
              t("ready") + " · " + status.channels.anonymous.minIntervalMs + "ms/" + status.channels.anonymous.burst
            )
          ),
          React.createElement(
            "div",
            { className: "dbr-row" },
            React.createElement("span", { className: "dbr-muted" }, t("authenticated")),
            React.createElement(
              "span",
              { className: signedIn ? "dbr-ok" : "dbr-off" },
              (signedIn ? t("ready") : t("notReady")) +
                " · " +
                status.channels.authenticated.minIntervalMs +
                "ms/" +
                status.channels.authenticated.burst +
                " · cap " +
                status.channels.authenticated.maxPerSession
            )
          )
        )
      );

      // ------------------------------------------------------------- cache
      children.push(
        React.createElement(
          "div",
          { className: "dbr-card", key: "cache" },
          React.createElement("h4", null, t("cacheTitle")),
          React.createElement(
            "div",
            { className: "dbr-row" },
            React.createElement("span", { className: "dbr-muted" }, t("cacheFiles")),
            React.createElement("span", null, cache.files + " / " + cache.maxFiles)
          ),
          React.createElement(
            "div",
            { className: "dbr-row" },
            React.createElement("span", { className: "dbr-muted" }, t("cacheSize")),
            React.createElement("span", null, humanBytes(cache.bytes) + " / " + humanBytes(cache.maxBytes))
          ),
          cache.dirs.map(function (row) {
            return React.createElement(
              "div",
              { className: "dbr-link", key: row.dir },
              row.dir + " — " + row.files + " · " + humanBytes(row.bytes)
            );
          }),
          React.createElement(
            "div",
            { className: "dbr-row" },
            React.createElement(
              "span",
              { className: "dbr-muted" },
              cache.files === 0 ? t("cacheEmpty") : ""
            ),
            React.createElement(
              "button",
              {
                className: "dbr-btn",
                type: "button",
                disabled: busy === "cache" || cache.files === 0,
                onClick: clearCache,
              },
              t("cacheClear")
            )
          )
        )
      );

      // ------------------------------------------------------------ config
      if (draft !== null) {
        var set = function (key) {
          return function (value) {
            setDraft(Object.assign({}, draft, { [key]: value }));
          };
        };
        children.push(
          React.createElement(
            "div",
            { className: "dbr-card", key: "config" },
            React.createElement("h4", null, t("configTitle")),
            React.createElement(NumberField, {
              label: t("anonInterval"),
              value: draft.anonMinIntervalMs,
              onChange: set("anonMinIntervalMs"),
            }),
            React.createElement(NumberField, {
              label: t("anonBurst"),
              value: draft.anonBurst,
              onChange: set("anonBurst"),
            }),
            React.createElement(NumberField, {
              label: t("authInterval"),
              value: draft.authMinIntervalMs,
              onChange: set("authMinIntervalMs"),
            }),
            React.createElement(NumberField, {
              label: t("authBurst"),
              value: draft.authBurst,
              onChange: set("authBurst"),
            }),
            React.createElement(NumberField, {
              label: t("authCap"),
              value: draft.authMaxPerSession,
              onChange: set("authMaxPerSession"),
            }),
            React.createElement(NumberField, {
              label: t("framesMaxFiles"),
              value: draft.framesMaxFiles,
              onChange: set("framesMaxFiles"),
            }),
            React.createElement(NumberField, {
              label: t("framesMaxMB"),
              value: Math.round(Number(draft.framesMaxBytes) / (1024 * 1024)),
              onChange: function (mb) {
                setDraft(Object.assign({}, draft, { framesMaxBytes: mb * 1024 * 1024 }));
              },
            }),
            React.createElement(
              "div",
              { className: "dbr-row" },
              React.createElement(
                "span",
                { className: "dbr-muted" },
                notice
              ),
              React.createElement(
                "button",
                {
                  className: "dbr-btn dbr-btn-primary",
                  type: "button",
                  disabled: busy === "config",
                  onClick: saveConfig,
                },
                t("save")
              )
            )
          )
        );
      }

      if (error) {
        children.push(React.createElement("div", { className: "dbr-err", key: "err" }, error));
      }

      return React.createElement("div", { className: "dbr-root" }, children);
    }

    /**
     * Compact header chip: shows whether the authenticated channel is live.
     * @returns {object} React element.
     */
    function HeaderChip() {
      var [signedIn, setSignedIn] = React.useState(null);

      React.useEffect(function () {
        var alive = true;
        apiGet("/status")
          .then(function (res) {
            if (!alive) return;
            setSignedIn(res.account !== null && res.account.valid === true);
          })
          .catch(function () {
            if (alive) setSignedIn(false);
          });
        return function () {
          alive = false;
        };
      }, []);

      var label = signedIn === null ? "B" : signedIn ? "B ✓" : "B";
      var color = signedIn === true ? "#10b981" : "#9ca3af";
      return React.createElement(
        "span",
        {
          className: "dbr-chip",
          title: signedIn === true ? t("loggedIn") : t("notLoggedIn"),
        },
        React.createElement("span", { className: "dbr-dot", style: { background: color } }),
        label
      );
    }

    // ----------------------------------------------------------------- apply

    /**
     * Register the panel into the DSH client.
     * @param {object} ctx - client plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      injectStyles();

      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") return;

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "dsh-bilibili-retrieval-settings",
            order: 96,
            label: function () {
              return t("sectionTitle");
            },
          },
          Panel
        );
      });

      ctx.slots.inject("conversation.session.header.actions", function () {
        return ctx.slots.register(
          {
            name: "conversation.session.header.actions",
            id: "dsh-bilibili-retrieval-header",
            order: 46,
          },
          HeaderChip
        );
      });
    }

    module.exports = {
      inject: ["slots", "locale"],
      apply: apply,
      __test: {
        I18N: I18N,
        t: t,
        humanBytes: humanBytes,
        currentLang: currentLang,
      },
    };

    return module.exports;
  },
});
