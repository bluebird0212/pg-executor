// ==UserScript==
// @name         Bluebird PG
// @namespace    https://github.com/bluebird0212/pg-executor
// @version      1.5.0
// @description  Bluebird PG：在 AI Studio 页面里执行 Gemini 请求，把结果回传给本地服务。支持防路由护盾、防截断、多缓存回放、请求历史、Token 统计和夜间模式。
// @author       bluebird0212
// @updateURL    https://raw.githubusercontent.com/bluebird0212/pg-executor/main/pg_executor.user.js
// @downloadURL  https://raw.githubusercontent.com/bluebird0212/pg-executor/main/pg_executor.user.js
// @match        https://aistudio.google.com/*
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @connect      localhost
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const VERSION = (typeof GM_info !== "undefined" && GM_info.script && GM_info.script.version) || "1.0.0";
  const GENERATE_RE = /MakerSuiteService\/GenerateContent/;
  const GENERATE_URL =
    "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
  const TEMP_CHAT_URL = "https://aistudio.google.com/prompts/new_chat?temporary=true";
  const BOOTSTRAP_PROMPT = "hi";
  const MAX_CACHE_BYTES = 8 * 1024 * 1024;
  const MAX_TOTAL_CACHE_BYTES = 24 * 1024 * 1024;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 15000, intervalMs = 250) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let v = null;
      try {
        v = fn();
      } catch (_) {}
      if (v) return v;
      if (Date.now() > deadline) return null;
      await sleep(intervalMs);
    }
  }

  function pick(storageKey, fallback) {
    try {
      if (typeof GM_getValue === "function") {
        const v = GM_getValue(storageKey);
        if (v !== undefined && v !== null) return v;
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) return raw;
    } catch (_) {}
    return fallback;
  }

  function save(storageKey, value) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(storageKey, value);
        return;
      }
    } catch (_) {}
    try {
      localStorage.setItem(storageKey, String(value));
    } catch (_) {}
  }

  function normalizeServer(raw) {
    let s = String(raw || "").trim();
    if (!s) return "http://127.0.0.1:8090";
    if (!/^https?:\/\//i.test(s)) s = "http://" + s;
    s = s.replace(/\/+$/, "");
    s = s.replace(/\/v1beta$/i, "");
    return s;
  }

  function apiBase() {
    return normalizeServer(state.server) + "/v1beta";
  }

  const state = {
    server: normalizeServer(pick("pgbridge.server", "http://127.0.0.1:8090")),
    connected: false,
    connecting: false,
    discovering: false,
    lastError: "",
    serviceReady: false,
    headersReady: false,
    snapshotKey: null,
    suppressUntil: 0,
    suppressBudget: 0,
    polling: false,
    currentTask: null,
    replayArmed: false,
    replayCacheId: null,
    caches: [],
    autoBootstrap: String(pick("pgbridge.autobootstrap", "1")) !== "0",
    autoBootstrapTried: false,
    shield: { enabled: true, mode: "deep" },
    antiTruncate: true,
    shieldLoaded: false,
    stats: { success: 0, fail: 0 },
    tokens: { prompt: 0, completion: 0, total: 0, last: null },
    history: [],
    apiKey: (function () {
      let key = String(pick("pgbridge.apikey", ""));
      if (!/^bb-[a-z0-9]{8,}$/i.test(key)) {
        key =
          "bb-" +
          Math.random().toString(36).slice(2, 10) +
          Math.random().toString(36).slice(2, 10);
        save("pgbridge.apikey", key);
      }
      return key;
    })(),
    logs: [],
    panel: null,
    ui: {},
    audio: null,
    keepAlive: String(pick("pgbridge.keepalive", "0")) === "1",
    themeMode: (function () {
      const value = String(pick("pgbridge.theme", "auto"));
      return ["auto", "light", "dark"].indexOf(value) >= 0 ? value : "auto";
    })(),
  };

  let themeMedia = null;
  try {
    themeMedia = W.matchMedia ? W.matchMedia("(prefers-color-scheme: dark)") : null;
  } catch (_) {
    themeMedia = null;
  }

  try {
    const rawCaches = pick("pgbridge.caches", "");
    if (rawCaches) {
      const parsed = JSON.parse(rawCaches);
      if (Array.isArray(parsed)) {
        state.caches = parsed
          .filter((c) => c && typeof c === "object" && typeof c.raw === "string" && c.raw)
          .slice(0, 10)
          .map((c, i) => ({
            id: String(c.id || "c" + (i + 1)),
            ts: Number(c.ts) || Date.now(),
            model: String(c.model || ""),
            stream: !!c.stream,
            raw: c.raw,
          }));
      }
    }
    if (!state.caches.length) {
      const rawCache = pick("pgbridge.cache", "");
      if (rawCache) {
        const old = JSON.parse(rawCache);
        if (old && typeof old.raw === "string" && old.raw) {
          state.caches = [
            {
              id: "c1",
              ts: Number(old.ts) || Date.now(),
              model: String(old.model || ""),
              stream: !!old.stream,
              raw: old.raw,
            },
          ];
        }
      }
    }
  } catch (_) {
    state.caches = [];
  }
  try {
    const rawStats = pick("pgbridge.stats", "");
    if (rawStats) state.stats = Object.assign(state.stats, JSON.parse(rawStats));
  } catch (_) {}
  try {
    const rawTokens = pick("pgbridge.tokens", "");
    if (rawTokens) {
      const parsed = JSON.parse(rawTokens);
      if (parsed && typeof parsed === "object") state.tokens = Object.assign(state.tokens, parsed);
    }
  } catch (_) {}
  try {
    const rawHistory = pick("pgbridge.history", "");
    if (rawHistory) {
      const parsed = JSON.parse(rawHistory);
      if (Array.isArray(parsed)) state.history = parsed.slice(0, 20);
    }
  } catch (_) {}

  // ------------------------------------------------------------------
  // 日志
  // ------------------------------------------------------------------

  function log(message) {
    const line = "[" + new Date().toLocaleTimeString() + "] " + message;
    state.logs.push(line);
    if (state.logs.length > 120) state.logs.shift();
    try {
      console.log("[Bluebird-PG]", message);
    } catch (_) {}
    renderLog();
  }

  // ------------------------------------------------------------------
  // 与本地服务通信（GM_xmlhttpRequest 可绕过 https 页面的混合内容限制）
  // ------------------------------------------------------------------

  function requestTo(base, method, path, body, timeout = 15000) {
    const target = normalizeServer(base);
    return new Promise((resolve, reject) => {
      const opts = {
        method,
        url: target + path,
        headers: { "content-type": "application/json" },
        timeout,
        onload(resp) {
          let data = null;
          try {
            data = resp.responseText ? JSON.parse(resp.responseText) : null;
          } catch (_) {
            data = resp.responseText;
          }
          resolve({ status: resp.status, data });
        },
        onerror() {
          reject(new Error("无法连接 " + target));
        },
        ontimeout() {
          reject(new Error("连接超时 " + target));
        },
      };
      if (body !== undefined && body !== null) opts.data = JSON.stringify(body);
      try {
        GM_xmlhttpRequest(opts);
      } catch (err) {
        reject(err);
      }
    });
  }

  function request(method, path, body, timeout = 15000) {
    return requestTo(state.server, method, path, body, timeout);
  }

  const SERVER_CANDIDATES = [
    "http://127.0.0.1:8090",
    "http://localhost:8090",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
    "http://127.0.0.1:8091",
    "http://localhost:8091",
  ];

  async function discoverServer() {
    if (state.discovering) return state.connected;
    state.discovering = true;
    renderStatus();
    const candidates = [];
    const add = (value) => {
      const base = normalizeServer(value);
      if (base && candidates.indexOf(base) < 0) candidates.push(base);
    };
    add(state.server);
    SERVER_CANDIDATES.forEach(add);
    for (const base of candidates) {
      try {
        const resp = await requestTo(base, "GET", "/api/status", null, 2500);
        if (
          resp.status === 200 &&
          resp.data &&
          resp.data.ok === true &&
          resp.data.executor &&
          typeof resp.data.executor === "object"
        ) {
          if (base !== state.server) {
            state.server = base;
            save("pgbridge.server", base);
            log("已自动找到本地服务: " + base);
          }
          state.connected = true;
          state.lastError = "";
          state.discovering = false;
          renderStatus();
          return true;
        }
      } catch (_) {}
    }
    state.discovering = false;
    state.connected = false;
    state.lastError = "未找到本地服务，请先双击 bluebird-pg.exe 或 start.bat 启动服务";
    renderStatus();
    return false;
  }

  function cacheSummary() {
    return state.caches.slice(0, 10).map((c) => ({
      id: c.id,
      ts: c.ts,
      model: c.model,
      stream: !!c.stream,
      chars: c.raw ? c.raw.length : 0,
    }));
  }

  async function postResult(payload) {
    let lastErr = null;
    for (let i = 0; i < 2; i++) {
      try {
        await request("POST", "/api/executor/result", payload, 15000);
        return true;
      } catch (err) {
        lastErr = err;
        await sleep(600);
      }
    }
    log("回传失败: " + (lastErr && lastErr.message));
    return false;
  }

  async function pollLoop() {
    if (state.polling) return;
    state.polling = true;
    let delay = 800;
    while (state.polling) {
      try {
        state.connecting = !state.connected;
        const resp = await request(
          "POST",
          "/api/executor/poll",
          {
            name: "aistudio-page",
            version: VERSION,
            models: [],
            caches: cacheSummary(),
            stats: state.stats,
          },
          40000
        );
        state.connecting = false;
        if (resp.status === 204) {
          state.connected = true;
          state.lastError = "";
          delay = 400;
          onServerReady();
          continue;
        }
        if (resp.status !== 200 || !resp.data || !resp.data.task) {
          throw new Error("服务返回 " + resp.status);
        }
        state.connected = true;
        state.lastError = "";
        delay = 400;
        onServerReady();
        const task = resp.data.task;
        try {
          await handleTask(task);
        } catch (err) {
          log("任务失败: " + (err && err.message));
          await postResult({
            id: task.id,
            kind: "error",
            status: 502,
            message: String((err && err.message) || err),
          });
        }
      } catch (err) {
        state.connected = false;
        state.connecting = false;
        state.lastError = "本地服务不可用：" + String((err && err.message) || err);
        const now = Date.now();
        if (now - (state.lastDiscoverAt || 0) > 15000) {
          state.lastDiscoverAt = now;
          const found = await discoverServer();
          if (found) {
            delay = 400;
            continue;
          }
        }
        await sleep(delay);
        delay = Math.min(5000, delay + 700);
      }
    }
  }

  // ------------------------------------------------------------------
  // 连接成功后的懒人动作：同步护盾状态 + 自动发送引导 hi
  // ------------------------------------------------------------------

  let shieldLoadedOnce = false;

  function onServerReady() {
    if (!shieldLoadedOnce) {
      shieldLoadedOnce = true;
      loadShieldState();
    }
    if (!state.autoBootstrap || state.autoBootstrapTried || waaReady()) return;
    state.autoBootstrapTried = true;
    setTimeout(() => {
      if (waaReady()) return;
      log("已连接服务，自动发送引导 hi…");
      bootstrap().catch((err) => log("自动引导失败: " + ((err && err.message) || err)));
    }, 2500);
  }

  async function loadShieldState() {
    try {
      const resp = await request("GET", "/api/shield", null, 6000);
      if (resp.status === 200 && resp.data && typeof resp.data === "object") {
        state.shield = {
          enabled: !!resp.data.enabled,
          mode: resp.data.mode === "standard" ? "standard" : "deep",
        };
        state.antiTruncate = !!resp.data.antiTruncate;
        renderStatus();
      }
    } catch (_) {}
  }

  async function saveShieldState() {
    try {
      await request(
        "POST",
        "/api/shield",
        {
          enabled: state.shield.enabled,
          mode: state.shield.mode,
          antiTruncate: state.antiTruncate,
        },
        6000
      );
    } catch (err) {
      log("保存护盾设置失败: " + ((err && err.message) || err));
    }
  }

  // ------------------------------------------------------------------
  // 页面环境捕获：请求头 / WAA 服务 / snapshot
  // ------------------------------------------------------------------

  const originalFetch = W.fetch ? W.fetch.bind(W) : null;

  function headersToObject(input) {
    const out = {};
    if (!input) return out;
    try {
      const H = W.Headers || Headers;
      if (H && typeof H === "function" && (input instanceof H || typeof input.forEach === "function")) {
        new H(input).forEach((v, k) => {
          out[String(k).toLowerCase()] = String(v);
        });
        return out;
      }
    } catch (_) {}
    if (Array.isArray(input)) {
      for (const pair of input) {
        if (pair && pair.length >= 2) out[String(pair[0]).toLowerCase()] = String(pair[1]);
      }
      return out;
    }
    if (typeof input === "object") {
      for (const k of Object.keys(input)) out[String(k).toLowerCase()] = String(input[k]);
    }
    return out;
  }

  function rememberHeaders(headers) {
    if (!headers || !Object.keys(headers).length) return;
    W.__pgBridgeHeaders = Object.assign({}, W.__pgBridgeHeaders || {}, headers);
    state.headersReady = true;
  }

  function maybeSuppressPageSend(headers) {
    if (headers) rememberHeaders(headers);
    if (Date.now() < state.suppressUntil && state.suppressBudget > 0) {
      state.suppressBudget -= 1;
      return true;
    }
    return false;
  }

  if (originalFetch) {
    W.fetch = function (input, init) {
      try {
        const url =
          typeof input === "string" ? input : input && input.url ? String(input.url) : "";
        if (GENERATE_RE.test(url)) {
          const method = String((init && init.method) || (input && input.method) || "GET").toUpperCase();
          if (method === "POST") {
            const headers = headersToObject(
              (init && init.headers) || (input && input.headers)
            );
            if (maybeSuppressPageSend(headers)) {
              const body = '{"error":{"message":"pg-bridge bootstrap interception"}}';
              const R = W.Response || Response;
              return Promise.resolve(
                new R(body, {
                  status: 502,
                  headers: { "content-type": "application/json" },
                })
              );
            }
          }
        }
      } catch (_) {}
      return originalFetch(input, init);
    };
  }

  try {
    const XHR = W.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      const origSetHeader = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (method, url) {
        try {
          this.__pgBridgeUrl = String(url || "");
          this.__pgBridgeHeaders = {};
        } catch (_) {}
        return origOpen.apply(this, arguments);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (!this.__pgBridgeHeaders) this.__pgBridgeHeaders = {};
          this.__pgBridgeHeaders[String(name).toLowerCase()] = String(value);
        } catch (_) {}
        return origSetHeader.apply(this, arguments);
      };
      XHR.prototype.send = function () {
        try {
          if (GENERATE_RE.test(String(this.__pgBridgeUrl || ""))) {
            rememberHeaders(this.__pgBridgeHeaders || {});
          }
        } catch (_) {}
        return origSend.apply(this, arguments);
      };
    }
  } catch (_) {}

  function installSnapshotHook() {
    const makerSuite = W.default_MakerSuite;
    if (!makerSuite) return "no_bundle";
    const current = state.snapshotKey;
    if (current && makerSuite[current] && makerSuite[current].__pgBridgeWrapped) {
      return "ok";
    }
    let bestKey = null;
    let bestYield = false;
    let keys = [];
    try {
      keys = Object.keys(makerSuite);
    } catch (_) {
      return "no_keys";
    }
    for (const key of keys) {
      let fn = null;
      try {
        fn = makerSuite[key];
      } catch (_) {
        continue;
      }
      if (typeof fn !== "function") continue;
      let source = "";
      try {
        source = Function.prototype.toString.call(fn);
      } catch (_) {
        continue;
      }
      if (source.indexOf(".snapshot({") < 0 || source.indexOf("content") < 0) continue;
      const hasYield = source.indexOf("yield") >= 0;
      if (!bestKey || (hasYield && !bestYield)) {
        bestKey = key;
        bestYield = hasYield;
      }
    }
    if (!bestKey) return "no_snapshot";
    const orig = makerSuite[bestKey];
    const wrapped = function () {
      try {
        const service = arguments[0];
        if (service && (typeof service === "object" || typeof service === "function")) {
          W.__pgBridgeService = service;
          state.serviceReady = true;
        }
      } catch (_) {}
      return orig.apply(this, arguments);
    };
    try {
      Object.assign(wrapped, orig);
    } catch (_) {}
    wrapped.__pgBridgeWrapped = true;
    makerSuite[bestKey] = wrapped;
    state.snapshotKey = bestKey;
    log("已捕获 snapshot（" + bestKey + "）");
    return "ok";
  }

  function startHookScanner() {
    const startedAt = Date.now();
    const tick = () => {
      try {
        if (W.default_MakerSuite) installSnapshotHook();
      } catch (_) {}
      const delay = Date.now() - startedAt < 120000 ? 2500 : 10000;
      setTimeout(tick, delay);
    };
    setTimeout(tick, 1500);
  }

  // ------------------------------------------------------------------
  // 自动引导：打开临时会话 → 发一条 hi → 捕获 service + 请求头
  // ------------------------------------------------------------------

  function isTemporaryChatPage() {
    return /temporary=true/i.test(location.search);
  }

  function getPromptTextarea() {
    const items = Array.from(document.querySelectorAll("ms-prompt-box textarea")).filter((el) => {
      try {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      } catch (_) {
        return false;
      }
    });
    if (!items.length) return null;
    let best = null;
    let bestArea = -1;
    for (const el of items) {
      const r = el.getBoundingClientRect();
      const area = Math.max(0, r.width) * Math.max(0, r.height);
      if (area >= bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function fillPrompt(text) {
    const textarea = getPromptTextarea();
    if (!textarea) throw new Error("未找到提示词输入框");
    const desc = Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, "value");
    if (desc && desc.set) desc.set.call(textarea, text);
    else textarea.value = text;
    textarea.dispatchEvent(
      new W.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: text,
      })
    );
    textarea.dispatchEvent(new W.Event("change", { bubbles: true }));
  }

  function clickRun() {
    const selectors = [
      "button.ctrl-enter-submits",
      "button.build-button",
      "button[aria-label*='Run']",
      "button[aria-label*='运行']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) {
        el.click();
        return sel;
      }
    }
    const buttons = Array.from(document.querySelectorAll("button"));
    const hit = buttons.find((b) => /^(Run|Build|运行|发送)$/i.test((b.innerText || "").trim()));
    if (hit) {
      hit.click();
      return "text";
    }
    const textarea = getPromptTextarea();
    if (textarea) {
      textarea.focus();
      textarea.dispatchEvent(
        new W.KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        })
      );
      return "enter";
    }
    return null;
  }

  function waaReady() {
    return !!(state.serviceReady && state.headersReady && state.snapshotKey);
  }

  let bootstrapPromise = null;

  async function bootstrap() {
    if (bootstrapPromise) return bootstrapPromise;
    bootstrapPromise = (async () => {
      if (!isTemporaryChatPage()) {
        location.assign(TEMP_CHAT_URL);
        throw new Error("正在打开临时会话页，请稍后重试（页面会自动加载）");
      }
      installSnapshotHook();
      const textarea = await waitFor(getPromptTextarea, 20000, 300);
      if (!textarea) throw new Error("未找到提示词输入框，请确认 AI Studio 页面已加载完成");
      state.suppressUntil = Date.now() + 15000;
      state.suppressBudget = 3;
      fillPrompt(BOOTSTRAP_PROMPT);
      await sleep(200);
      const via = clickRun();
      if (!via) throw new Error("未找到 Run/发送按钮，请手动发一条消息完成引导");
      log("已触发页面发送（" + via + "），等待签名环境就绪…");
      const ok = await waitFor(() => (waaReady() ? true : null), 35000, 250);
      if (!ok) {
        throw new Error("引导超时：页面未完成签名，请手动在 AI Studio 发一条消息后再试");
      }
      log("引导完成：service + 请求头已就绪");
      return true;
    })();
    try {
      return await bootstrapPromise;
    } finally {
      bootstrapPromise = null;
      state.suppressUntil = 0;
      state.suppressBudget = 0;
      try {
        const textarea = getPromptTextarea();
        if (textarea && textarea.value === BOOTSTRAP_PROMPT) {
          const desc = Object.getOwnPropertyDescriptor(W.HTMLTextAreaElement.prototype, "value");
          if (desc && desc.set) desc.set.call(textarea, "");
          else textarea.value = "";
          textarea.dispatchEvent(new W.Event("input", { bubbles: true }));
        }
      } catch (_) {}
    }
  }

  // ------------------------------------------------------------------
  // 执行请求
  // ------------------------------------------------------------------

  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  async function sha1Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
    return m ? m[1] : null;
  }

  async function freshAuthorization() {
    try {
      const sapisid = getCookie("SAPISID") || getCookie("__Secure-1PAPISID") || getCookie("APISID");
      if (!sapisid) return null;
      const sapisid1p = getCookie("__Secure-1PAPISID") || sapisid;
      const sapisid3p = getCookie("__Secure-3PAPISID") || sapisid;
      const ts = Math.floor(Date.now() / 1000);
      const calc = async (v) => sha1Hex(ts + " " + v + " " + W.location.origin);
      return [
        "SAPISIDHASH " + ts + "_" + (await calc(sapisid)),
        "SAPISID1PHASH " + ts + "_" + (await calc(sapisid1p)),
        "SAPISID3PHASH " + ts + "_" + (await calc(sapisid3p)),
      ].join(" ");
    } catch (_) {
      return null;
    }
  }

  async function buildHeaders() {
    const headers = Object.assign({}, W.__pgBridgeHeaders || {});
    for (const key of Object.keys(headers)) {
      if (/^(content-length|host|connection)$/i.test(key)) delete headers[key];
    }
    headers["content-type"] = "application/json+protobuf";
    const fresh = await freshAuthorization();
    if (fresh && (!headers.authorization || String(headers.authorization).startsWith("SAPISIDHASH "))) {
      headers.authorization = fresh;
    }
    return headers;
  }

  async function takeProof(digest) {
    const makerSuite = W.default_MakerSuite;
    if (!makerSuite) throw new Error("页面模块未就绪（default_MakerSuite 不存在）");
    const timeout = (ms) =>
      new Promise((_, reject) => setTimeout(() => reject(new Error("proof 超时")), ms));
    let lastErr = null;
    for (let round = 0; round < 3; round++) {
      installSnapshotHook();
      const service = W.__pgBridgeService;
      const key = state.snapshotKey;
      if (!service || !key || typeof makerSuite[key] !== "function") {
        throw new Error("签名环境未就绪，请先完成引导");
      }
      try {
        const proof = await Promise.race([
          Promise.resolve(makerSuite[key](service, digest)),
          timeout(round === 0 ? 8000 : 12000),
        ]);
        if (typeof proof !== "string" || proof.indexOf("!") !== 0) {
          throw new Error("proof 格式异常");
        }
        return proof;
      } catch (err) {
        lastErr = err;
        await sleep(300);
      }
    }
    throw new Error("生成 proof 失败: " + (lastErr && lastErr.message));
  }

  async function ensureReady() {
    if (waaReady()) return;
    await bootstrap();
    if (!waaReady()) throw new Error("签名环境仍未就绪");
    if (!state.headersReady) throw new Error("未捕获到页面请求头，请手动发一条消息后重试");
  }

  function saveCache(model, stream, raw) {
    if (!raw || raw.length > MAX_CACHE_BYTES) return;
    state.caches.unshift({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      model: model || "",
      stream: !!stream,
      raw,
    });
    if (state.caches.length > 10) state.caches.length = 10;
    let total = state.caches.reduce((sum, c) => sum + (c.raw ? c.raw.length : 0), 0);
    while (state.caches.length > 1 && total > MAX_TOTAL_CACHE_BYTES) {
      const removed = state.caches.pop();
      total -= removed && removed.raw ? removed.raw.length : 0;
    }
    try {
      save("pgbridge.caches", JSON.stringify(state.caches));
    } catch (err) {
      log("缓存保存失败: " + (err && err.message));
    }
    renderCaches();
    renderStatus();
  }

  function bumpStats(ok) {
    if (ok) state.stats.success += 1;
    else state.stats.fail += 1;
    try {
      save("pgbridge.stats", JSON.stringify(state.stats));
    } catch (_) {}
  }

  function fmtNum(value) {
    const n = Number(value) || 0;
    if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return String(n);
  }

  function readUsage(usage) {
    if (!Array.isArray(usage) || !usage.length) return null;
    const prompt = Number(usage[0]) || 0;
    const visible = Number(usage[1]) || 0;
    const total = Number(usage[2]) || 0;
    const reasoning = Number(usage[9]) || 0;
    const completion = visible + reasoning;
    if (!prompt && !completion && !total) return null;
    return {
      prompt,
      completion,
      total: total || prompt + completion,
      reasoning,
    };
  }

  // 从上游原始 JSON / 拼接的流式 JSON 里提取最后一次 usage
  function extractUsage(raw) {
    if (!raw) return null;
    let latest = null;
    const visit = (chunk) => {
      if (!Array.isArray(chunk)) return;
      const usage = readUsage(chunk[2]);
      if (usage) latest = usage;
    };
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        visit(parsed);
        if (latest) return latest;
      }
    } catch (_) {}
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "[" || ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          try {
            visit(JSON.parse(raw.slice(start, i + 1)));
          } catch (_) {}
          start = -1;
        }
      }
    }
    return latest;
  }

  function bumpTokens(usage) {
    if (!usage) return;
    state.tokens.prompt += usage.prompt || 0;
    state.tokens.completion += usage.completion || 0;
    state.tokens.total += usage.total || 0;
    state.tokens.last = usage;
    try {
      save("pgbridge.tokens", JSON.stringify(state.tokens));
    } catch (_) {}
  }

  function pushHistory(entry) {
    state.history.unshift(entry);
    if (state.history.length > 20) state.history.length = 20;
    try {
      save("pgbridge.history", JSON.stringify(state.history));
    } catch (_) {}
    renderHistory();
  }

  function notify(message, ok) {
    log(message);
    const ui = state.ui;
    if (!ui || !ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.className = "toast show " + (ok ? "ok" : "bad");
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      ui.toast.className = "toast " + (ok ? "ok" : "bad");
    }, 3200);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
      document.documentElement.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (_) {
      return false;
    }
  }

  function splitChunks(text, size) {
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  async function replayTask(task, entry) {
    const raw = entry && entry.raw;
    if (!raw) throw new Error("没有可用缓存");
    state.replayArmed = false;
    state.replayCacheId = null;
    if (task.stream) {
      const pieces = splitChunks(raw, 4096);
      for (const piece of pieces) {
        await postResult({ id: task.id, kind: "chunk", chunkBody: piece });
      }
      await postResult({ id: task.id, kind: "end", status: 200 });
    } else {
      await postResult({ id: task.id, kind: "response", status: 200, rawResponse: raw });
    }
    log(
      "缓存回放完成（" +
        new Date(entry.ts).toLocaleTimeString() +
        " · " +
        raw.length +
        " 字符）"
    );
    renderStatus();
    return null;
  }

  function parseUpstreamMessage(text) {
    if (!text) return "";
    try {
      const payload = JSON.parse(text);
      const out = [];
      const walk = (node) => {
        if (typeof node === "string" && node.length > 6 && /\s/.test(node)) out.push(node);
        else if (Array.isArray(node)) node.forEach(walk);
      };
      walk(payload);
      if (out.length) return out.sort((a, b) => b.length - a.length)[0].slice(0, 300);
    } catch (_) {}
    return String(text).replace(/\s+/g, " ").slice(0, 300);
  }

  async function executeTask(task) {
    await ensureReady();
    let parsed;
    try {
      parsed = JSON.parse(task.requestBody || "{}");
    } catch (err) {
      throw new Error("requestBody 不是有效 JSON");
    }
    const wire = parsed.wire;
    const binding = parsed.binding;
    if (!Array.isArray(wire) || typeof binding !== "string") {
      throw new Error("requestBody 缺少 wire/binding");
    }
    const digest = await sha256Hex(binding);
    const proof = await takeProof(digest);
    wire[4] = proof;

    const headers = await buildHeaders();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      try {
        controller.abort();
      } catch (_) {}
    }, 300000);

    let raw = "";
    try {
      const fetchFn = originalFetch || W.fetch;
      const resp = await fetchFn(GENERATE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(wire),
        credentials: "include",
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const detail = parseUpstreamMessage(text);
        throw new Error("上游 HTTP " + resp.status + (detail ? ": " + detail : ""));
      }
      if (task.stream && resp.body && typeof resp.body.getReader === "function") {
        const reader = resp.body.getReader();
        const decoder = new TextDecoder("utf-8");
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const piece = decoder.decode(value, { stream: true });
          if (!piece) continue;
          raw += piece;
          await postResult({ id: task.id, kind: "chunk", chunkBody: piece });
        }
        const tail = decoder.decode();
        if (tail) {
          raw += tail;
          await postResult({ id: task.id, kind: "chunk", chunkBody: tail });
        }
        if (!raw.trim()) throw new Error("上游返回空内容");
        await postResult({ id: task.id, kind: "end", status: 200 });
      } else {
        raw = await resp.text();
        if (!raw.trim()) throw new Error("上游返回空内容");
        await postResult({ id: task.id, kind: "response", status: 200, rawResponse: raw });
      }
    } finally {
      clearTimeout(timer);
    }

    saveCache(task.model, task.stream, raw);
    const usage = extractUsage(raw);
    log("完成 " + task.id.slice(0, 8) + "（" + raw.length + " 字符）");
    return usage;
  }

  async function handleTask(task) {
    state.currentTask = task;
    renderStatus();
    await postResult({ id: task.id, kind: "ack" });
    const startedAt = Date.now();
    const replayEntry = state.replayArmed
      ? state.caches.find((c) => c.id === state.replayCacheId) || state.caches[0]
      : null;
    const usedReplay = !!(replayEntry && replayEntry.raw);
    if (usedReplay) log("使用缓存回放 " + String(task.id).slice(0, 8));
    try {
      const usage = usedReplay ? await replayTask(task, replayEntry) : await executeTask(task);
      const ms = Date.now() - startedAt;
      bumpStats(true);
      bumpTokens(usage);
      pushHistory({
        ts: Date.now(),
        model: task.model || "",
        stream: !!task.stream,
        ok: true,
        ms,
        prompt: usage ? usage.prompt : 0,
        completion: usage ? usage.completion : 0,
        total: usage ? usage.total : 0,
        replay: usedReplay,
      });
      notify(
        (usedReplay ? "🎀 缓存回放完成" : "✅ 请求完成") +
          " · " +
          (task.model || "未知模型") +
          " · " +
          (ms / 1000).toFixed(1) +
          "s" +
          (usage ? " · " + fmtNum(usage.total) + " tokens" : ""),
        true
      );
    } catch (err) {
      bumpStats(false);
      pushHistory({
        ts: Date.now(),
        model: task.model || "",
        stream: !!task.stream,
        ok: false,
        ms: Date.now() - startedAt,
        prompt: 0,
        completion: 0,
        total: 0,
        replay: usedReplay,
        error: String((err && err.message) || err).slice(0, 200),
      });
      notify("❌ 请求失败：" + String((err && err.message) || err), false);
      throw err;
    } finally {
      state.currentTask = null;
      renderStatus();
    }
  }

  // ------------------------------------------------------------------
  // 后台音频保活
  // ------------------------------------------------------------------

  function startAudio() {
    const Ctx = W.AudioContext || W.webkitAudioContext;
    if (!Ctx) throw new Error("浏览器不支持 AudioContext");
    if (!state.audio) {
      state.audio = new Ctx();
      const osc = state.audio.createOscillator();
      const gain = state.audio.createGain();
      gain.gain.value = 0.0001;
      osc.frequency.value = 40;
      osc.connect(gain);
      gain.connect(state.audio.destination);
      osc.start();
    }
    state.audio.resume();
  }

  function toggleKeepAlive() {
    state.keepAlive = !state.keepAlive;
    save("pgbridge.keepalive", state.keepAlive ? "1" : "0");
    try {
      if (state.keepAlive) {
        startAudio();
        log("后台保活已开启（请保持页面标签存在）");
      } else if (state.audio) {
        state.audio.suspend();
        log("后台保活已关闭");
      }
    } catch (err) {
      log("保活失败: " + (err && err.message));
    }
    renderStatus();
  }

  // ------------------------------------------------------------------
  // 面板
  // ------------------------------------------------------------------

  const PANEL_CSS = `
:host{all:initial}
*{box-sizing:border-box}
.wrap{--bg1:#f3f7ff;--bg2:#eef4fd;--card:#ffffff;--line:#cfdcf0;--fg:#33415c;--muted:#8494ac;--accent:#7799cc;--accent2:#9fc3e8;--ok:#3aa981;--bad:#e26d7e;--warn:#d99a3d;--shadow:0 18px 50px rgba(119,153,204,.30);--glow:rgba(119,153,204,.20);--input:#f7faff;
font:13px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg)}
.wrap[data-theme="dark"]{--bg1:#1d2736;--bg2:#151c27;--card:#243146;--line:#3c4d66;--fg:#eaf1fb;--muted:#a2b3c9;--accent:#7799cc;--accent2:#9fd6e8;--ok:#5fd3ae;--bad:#ff8fa0;--warn:#f2c66d;--shadow:0 18px 50px rgba(0,0,0,.62);--glow:rgba(119,153,204,.22);--input:#1b2432}
.card{position:relative;width:min(440px,calc(100vw - 20px));background:linear-gradient(155deg,var(--bg1),var(--bg2));border:1.5px solid var(--line);border-radius:22px;overflow:hidden;box-shadow:var(--shadow)}
.card::before{content:"";position:absolute;right:-46px;top:-64px;width:170px;height:170px;border-radius:50%;background:radial-gradient(circle,var(--glow),transparent 70%);pointer-events:none}
.head{position:relative;display:flex;align-items:center;gap:10px;padding:12px 12px 11px 13px;border-bottom:1px solid var(--line);background:linear-gradient(135deg,rgba(119,153,204,.16),rgba(159,195,232,.13))}
.mascot{flex:none;width:46px;height:46px;border-radius:15px;display:grid;place-items:center;font-size:27px;background:linear-gradient(145deg,#e3efff,#dff6f4);box-shadow:inset 0 0 0 1px rgba(255,255,255,.65),0 6px 16px rgba(119,153,204,.30);animation:bob 3.2s ease-in-out infinite}
@keyframes bob{0%,100%{transform:translateY(0) rotate(-2deg)}50%{transform:translateY(-3px) rotate(2deg)}}
.brand{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.title{display:flex;align-items:center;gap:6px;font-size:16px;font-weight:800;letter-spacing:.2px;line-height:1.2}
.title small{font-weight:700;font-size:9.5px;color:var(--muted);background:var(--input);border:1px solid var(--line);padding:1px 6px;border-radius:999px}
.sub{font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.headActions{display:flex;align-items:center;gap:6px}
.theme{height:28px;padding:0 9px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:10.5px;cursor:pointer;white-space:nowrap;transition:border-color .15s,transform .12s}
.theme:hover{border-color:var(--accent);transform:translateY(-1px)}
.ib{flex:none;width:28px;height:28px;border:0;border-radius:9px;background:transparent;color:var(--muted);font-size:16px;cursor:pointer;line-height:1}
.ib:hover{background:var(--card);color:var(--fg)}
.body{padding:12px 14px 14px;display:flex;flex-direction:column;gap:10px;max-height:min(78vh,660px);overflow:auto}
.body::-webkit-scrollbar{width:6px}
.body::-webkit-scrollbar-thumb{background:var(--line);border-radius:99px}
.statusRow{display:flex;align-items:center;gap:9px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:9px 11px}
.dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--muted);transition:background .2s,box-shadow .2s}
.dot.ok{background:var(--ok);box-shadow:0 0 0 4px rgba(47,201,141,.16)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 4px rgba(230,165,46,.16)}
.dot.err{background:var(--bad);box-shadow:0 0 0 4px rgba(255,107,139,.16)}
.statusText{display:flex;flex-direction:column;line-height:1.25;min-width:0}
.statusText strong{font-size:12.5px;font-weight:750}
.statusText span{font-size:10.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.counts{margin-left:auto;font-size:11px;color:var(--muted);background:var(--input);border:1px solid var(--line);border-radius:999px;padding:3px 8px;white-space:nowrap}
.errline{display:none;background:rgba(255,107,139,.12);border:1px solid rgba(255,107,139,.45);color:var(--bad);padding:8px 10px;border-radius:12px;font-size:11.5px;line-height:1.45;word-break:break-word}
.errline.show{display:block}
.setup{display:none;flex-direction:column;gap:7px;background:linear-gradient(135deg,rgba(119,153,204,.13),rgba(159,195,232,.12));border:1px dashed var(--accent);border-radius:15px;padding:11px 12px}
.setup.show{display:flex}
.setupTitle{font-size:12px;font-weight:750;color:var(--fg)}
.setupStep{font-size:11.5px;color:var(--muted);line-height:1.45}
.setupStep b{color:var(--fg)}
.setupActions{display:flex;gap:6px;margin-top:2px}
.setupActions .btn{flex:1;height:31px}
.setupHint{font-size:10.5px;color:var(--muted)}
.field{display:flex;flex-direction:column;gap:5px}
.label{font-size:10px;color:var(--muted);font-weight:750;letter-spacing:.5px}
.inputRow{display:flex;gap:6px}
.input{flex:1;min-width:0;height:34px;padding:0 10px;border-radius:11px;border:1px solid var(--line);background:var(--input);color:var(--fg);font:inherit;font-size:12.5px;outline:none;transition:border-color .15s,box-shadow .15s}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--glow)}
.btn{height:33px;padding:0 10px;border-radius:11px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;transition:transform .12s,border-color .12s,background .12s}
.btn:hover{border-color:var(--accent);transform:translateY(-1px)}
.btn:active{transform:scale(.98)}
.btn.primary{background:linear-gradient(135deg,#8fb0dd,#7799cc);border-color:transparent;color:#fff;box-shadow:0 6px 16px rgba(119,153,204,.35);font-weight:700}
.btn.warn{color:var(--warn);border-color:rgba(230,165,46,.5)}
.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}
.stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:7px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:7px 5px 6px;text-align:center;min-width:0}
.stat b{display:block;font-size:16px;line-height:1.25;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.stat span{font-size:9.5px;color:var(--muted)}
.stat.ok b{color:var(--ok)}
.stat.bad b{color:var(--bad)}
.stat.busy b{color:var(--accent)}
.line{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:11.5px;min-width:0}
.strong{color:var(--fg);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.footerRow{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.footerRow .btn{padding:0 4px;font-size:10.5px}
.mini{flex:none;height:22px;padding:0 7px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:9.5px;cursor:pointer;white-space:nowrap}
.mini:hover{border-color:var(--accent);color:var(--accent)}
.mini.on{background:linear-gradient(135deg,#8fb0dd,#7799cc);border-color:transparent;color:#fff}
.log{display:none;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto;background:var(--input);border:1px solid var(--line);border-radius:12px;padding:8px 10px;font:10.5px/1.55 ui-monospace,Consolas,monospace;color:var(--muted)}
.log.show{display:block}
.apiBox{display:flex;flex-direction:column;gap:6px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px 11px}
.apiHead{display:flex;align-items:center;justify-content:space-between;gap:6px}
.apiTitle{font-size:11px;font-weight:750;color:var(--fg)}
.apiHint{font-size:9.5px;color:var(--muted)}
.apiRow{display:flex;align-items:center;gap:6px;min-width:0}
.apiLabel{flex:none;width:52px;font-size:10px;color:var(--muted)}
.apiValue{flex:1;min-width:0;font:10.5px/1.4 ui-monospace,Consolas,monospace;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.apiActions{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.apiActions .btn{height:29px;font-size:10.5px;padding:0 4px}
.historyWrap{display:none;background:var(--input);border:1px solid var(--line);border-radius:12px;padding:7px 9px;max-height:190px;overflow:auto;flex-direction:column;gap:5px}
.historyWrap.show{display:flex}
.hitem{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--muted);min-width:0}
.hdot{flex:none;width:14px;text-align:center;font-weight:800}
.hdot.ok{color:var(--ok)}
.hdot.bad{color:var(--bad)}
.htime{flex:none;font-variant-numeric:tabular-nums}
.hmodel{flex:1;min-width:0;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hms{flex:none}
.htok{flex:none;color:var(--accent)}
.hempty{font-size:10.5px;color:var(--muted);text-align:center;padding:6px}
.toast{position:fixed;left:50%;top:14px;transform:translate(-50%,-14px);z-index:2147483647;max-width:min(420px,calc(100vw - 24px));background:var(--card);color:var(--fg);border:1px solid var(--line);border-left:4px solid var(--ok);border-radius:12px;padding:9px 12px;font:12px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.28);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;word-break:break-word}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{border-left-color:var(--bad)}
@media(max-width:480px){.card{width:calc(100vw - 16px)}.body{max-height:70vh}.theme{padding:0 7px}}
`;

  // AI Studio 启用了 Trusted Types，禁止 innerHTML，这里全部用 DOM API 建面板
  function h(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === null || value === undefined) continue;
        if (key === "class") node.className = String(value);
        else if (key === "text") node.textContent = String(value);
        else if (key === "style") node.style.cssText = String(value);
        else if (key.slice(0, 2) === "on" && typeof value === "function") {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === "dataset" && typeof value === "object") {
          for (const dataKey of Object.keys(value)) node.dataset[dataKey] = String(value[dataKey]);
        } else {
          node.setAttribute(key, String(value));
        }
      }
    }
    const list = children === null || children === undefined ? [] : [].concat(children);
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return node;
  }

  function currentDark() {
    if (state.themeMode === "dark") return true;
    if (state.themeMode === "light") return false;
    return !!(themeMedia && themeMedia.matches);
  }

  function applyTheme() {
    const ui = state.ui;
    if (!ui) return;
    const dark = currentDark();
    if (ui.wrap) ui.wrap.dataset.theme = dark ? "dark" : "light";
    if (ui.theme) {
      const mode = state.themeMode;
      ui.theme.textContent =
        mode === "auto"
          ? dark
            ? "🌙 自动"
            : "☀️ 自动"
          : mode === "dark"
            ? "🌙 夜间"
            : "☀️ 日间";
      ui.theme.title = "切换主题：自动 / 日间 / 夜间";
    }
  }

  function buildPanel() {
    const host = document.createElement("div");
    host.id = "pg-bridge-panel";
    host.setAttribute("data-pg-bridge", "panel");
    host.style.cssText =
      "position:fixed;right:10px;bottom:10px;z-index:2147483647;pointer-events:auto;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const wrap = h("div", { class: "wrap", dataset: { theme: currentDark() ? "dark" : "light" } });
    const themeBtn = h(
      "button",
      { class: "theme", id: "themeBtn", type: "button", title: "切换主题：自动 / 日间 / 夜间" },
      "🌙 自动"
    );
    const collapseBtn = h(
      "button",
      { class: "ib", id: "collapse", type: "button", title: "折叠面板" },
      "—"
    );
    const header = h("div", { class: "head" }, [
      h("div", { class: "mascot", title: "Bluebird PG 小助手" }, "🐰"),
      h("div", { class: "brand" }, [
        h("div", { class: "title" }, ["Bluebird PG", h("small", { text: "v" + VERSION })]),
        h("div", { class: "sub", text: "AI Studio 执行器 · 蓝鸟工作中" }),
      ]),
      h("div", { class: "headActions" }, [themeBtn, collapseBtn]),
    ]);

    const dot = h("span", { class: "dot", id: "dot" });
    const conn = h("strong", { id: "conn", text: "未连接" });
    const waa = h("span", { id: "waa", text: "签名未就绪" });
    const counts = h("span", { class: "counts", id: "counts", text: "✓0 ✗0" });
    const statusRow = h("div", { class: "statusRow" }, [
      dot,
      h("div", { class: "statusText" }, [conn, waa]),
      counts,
    ]);

    const lastError = h("div", { class: "errline", id: "lastError" });
    const downloadBtn = h("button", {
      class: "btn primary",
      id: "download",
      type: "button",
      text: "⬇️ 下载服务",
    });
    const retrySetupBtn = h("button", {
      class: "btn",
      id: "retrySetup",
      type: "button",
      text: "🔄 我已启动",
    });
    const setupBox = h("div", { class: "setup", id: "setup" }, [
      h("div", { class: "setupTitle" }, "👋 还差一步：启动本地服务"),
      h("div", { class: "setupStep" }, [
        "① 下载并双击 ",
        h("b", { text: "bluebird-pg.exe" }),
        "（或 start.bat）",
      ]),
      h("div", { class: "setupStep" }, [
        "② 回到页面点 ",
        h("b", { text: "我已启动" }),
        "，面板显示“已连接”即可",
      ]),
      h("div", { class: "setupActions" }, [downloadBtn, retrySetupBtn]),
      h("div", {
        class: "setupHint",
        text: "服务窗口不要关；首次启动 Windows 防火墙请点“允许”。",
      }),
    ]);
    const serverInput = h("input", {
      class: "input",
      id: "server",
      type: "text",
      spellcheck: "false",
      placeholder: "http://127.0.0.1:8090",
    });
    const saveBtn = h("button", { class: "btn", id: "save", type: "button", text: "保存" });
    const lanBtn = h("button", {
      class: "btn",
      id: "lan",
      type: "button",
      text: "🏠 局域网",
      title: "自动获取本机局域网地址并填写",
    });
    const serverField = h("div", { class: "field" }, [
      h("div", { class: "label", text: "本地服务地址" }),
      h("div", { class: "inputRow" }, [serverInput, lanBtn, saveBtn]),
    ]);

    const apiHostText = h("span", { class: "apiValue", id: "apiHost", text: "—" });
    const apiKeyText = h("span", { class: "apiValue", id: "apiKey", text: state.apiKey });
    const copyHostBtn = h("button", {
      class: "btn",
      id: "copyHost",
      type: "button",
      text: "📋 主机",
    });
    const copyKeyBtn = h("button", {
      class: "btn",
      id: "copyKey",
      type: "button",
      text: "🔑 Key",
    });
    const copyAllBtn = h("button", {
      class: "btn primary",
      id: "copyAll",
      type: "button",
      text: "📦 全部",
    });
    const apiBox = h("div", { class: "apiBox" }, [
      h("div", { class: "apiHead" }, [
        h("span", { class: "apiTitle", text: "客户端连接" }),
        h("span", { class: "apiHint", text: "协议选 Google Gemini" }),
      ]),
      h("div", { class: "apiRow" }, [
        h("span", { class: "apiLabel", text: "API 主机" }),
        apiHostText,
      ]),
      h("div", { class: "apiRow" }, [
        h("span", { class: "apiLabel", text: "API Key" }),
        apiKeyText,
      ]),
      h("div", { class: "apiActions" }, [copyHostBtn, copyKeyBtn, copyAllBtn]),
    ]);

    const reconnectBtn = h("button", {
      class: "btn primary",
      id: "reconnect",
      type: "button",
      text: "🔗 重新连接",
    });
    const bootstrapBtn = h("button", {
      class: "btn",
      id: "bootstrap",
      type: "button",
      text: "✨ 手动引导",
    });
    const replayBtn = h("button", {
      class: "btn warn",
      id: "replay",
      type: "button",
      text: "🎀 缓存回放",
    });
    const clearBtn = h("button", {
      class: "btn",
      id: "clear",
      type: "button",
      text: "🧹 清空缓存",
    });
    const actions = h("div", { class: "grid" }, [
      reconnectBtn,
      bootstrapBtn,
      replayBtn,
      clearBtn,
    ]);

    const okCount = h("b", { id: "okCount", text: "0" });
    const badCount = h("b", { id: "badCount", text: "0" });
    const taskState = h("b", { id: "taskState", text: "空闲" });
    const taskStat = h("div", { class: "stat", id: "taskStat" }, [
      taskState,
      h("span", { text: "状态" }),
    ]);
    const statsRow = h("div", { class: "stats" }, [
      h("div", { class: "stat ok" }, [okCount, h("span", { text: "成功" })]),
      h("div", { class: "stat bad" }, [badCount, h("span", { text: "失败" })]),
      taskStat,
    ]);

    const tokenTotal = h("b", { class: "strong", id: "tokenTotal", text: "0" });
    const tokenDetail = h("span", { id: "tokenDetail", text: "上次 —" });
    const tokenRow = h("div", { class: "line" }, [
      h("span", { class: "label", text: "Token" }),
      tokenTotal,
      tokenDetail,
    ]);

    const historyBtn = h("button", {
      class: "btn",
      id: "historyBtn",
      type: "button",
      text: "🕘 最近请求",
    });
    const historyBox = h("div", { class: "historyWrap", id: "history" });

    const cacheInfo = h("span", { class: "strong", id: "cacheInfo", text: "无" });
    const cacheBtn = h("button", {
      class: "btn",
      id: "cacheBtn",
      type: "button",
      text: "📦 管理",
    });
    const cacheRow = h("div", { class: "line" }, [
      h("span", { class: "label", text: "缓存" }),
      cacheInfo,
      cacheBtn,
    ]);
    const cacheWrap = h("div", { class: "historyWrap", id: "cacheList" });

    const keepaliveBtn = h("button", {
      class: "btn",
      id: "keepalive",
      type: "button",
      text: "🔔 保活",
    });
    const logBtn = h("button", { class: "btn", id: "logbtn", type: "button", text: "📜 日志" });
    const copyBtn = h("button", { class: "btn", id: "copylog", type: "button", text: "📋 复制" });
    const consoleBtn = h("button", {
      class: "btn",
      id: "openconsole",
      type: "button",
      text: "🌐 后台",
    });
    const autoBootBtn = h("button", {
      class: "btn",
      id: "autoboot",
      type: "button",
      text: "✨ 自动引导",
      title: "连接成功后自动发送一条 hi 完成签名引导",
    });
    const shieldBtn = h("button", {
      class: "btn",
      id: "shield",
      type: "button",
      text: "🛡 防路由",
      title: "切换服务端防路由护盾与防截断",
    });
    const footerRow = h("div", { class: "footerRow" }, [
      autoBootBtn,
      shieldBtn,
      keepaliveBtn,
      logBtn,
      copyBtn,
      consoleBtn,
    ]);
    const logBox = h("div", { class: "log", id: "log" });
    const toast = h("div", { class: "toast", id: "toast" });
    const body = h("div", { class: "body", id: "body" }, [
      statusRow,
      lastError,
      setupBox,
      serverField,
      apiBox,
      actions,
      statsRow,
      tokenRow,
      cacheRow,
      cacheWrap,
      historyBtn,
      historyBox,
      footerRow,
      logBox,
    ]);
    const card = h("div", { class: "card" }, [header, body]);
    wrap.appendChild(card);
    wrap.appendChild(toast);
    root.appendChild(style);
    root.appendChild(wrap);
    const rootNode = document.documentElement || document.body;
    rootNode.appendChild(host);
    const oldFallback = document.getElementById("pg-bridge-fallback");
    if (oldFallback) oldFallback.remove();
    state.panel = host;
    state.ui = {
      wrap,
      dot,
      counts,
      conn,
      waa,
      lastError,
      setup: setupBox,
      download: downloadBtn,
      retrySetup: retrySetupBtn,
      server: serverInput,
      lan: lanBtn,
      save: saveBtn,
      apiHost: apiHostText,
      apiKey: apiKeyText,
      copyHost: copyHostBtn,
      copyKey: copyKeyBtn,
      copyAll: copyAllBtn,
      tokenTotal,
      tokenDetail,
      historyBtn,
      history: historyBox,
      toast,
      reconnect: reconnectBtn,
      bootstrap: bootstrapBtn,
      replay: replayBtn,
      clear: clearBtn,
      cacheInfo,
      cacheBtn,
      cacheWrap,
      autoBoot: autoBootBtn,
      shield: shieldBtn,
      okCount,
      badCount,
      taskState,
      taskStat,
      keepalive: keepaliveBtn,
      logbtn: logBtn,
      copylog: copyBtn,
      openconsole: consoleBtn,
      log: logBox,
      collapse: collapseBtn,
      theme: themeBtn,
      body,
    };
    const ui = state.ui;
    ui.server.value = state.server;
    ui.save.addEventListener("click", () => {
      state.server = normalizeServer(ui.server.value);
      ui.server.value = state.server;
      save("pgbridge.server", state.server);
      log("服务器地址已保存: " + state.server);
      renderStatus();
    });
    ui.lan.addEventListener("click", async () => {
      log("正在获取局域网地址…");
      try {
        const resp = await requestTo(state.server, "GET", "/api/status", null, 6000);
        const net = resp.data && resp.data.network;
        const port = (net && net.port) || 8090;
        const lan = net && Array.isArray(net.lan)
          ? net.lan.filter((ip) => ip && !/^127\./.test(ip))
          : [];
        if (!lan.length) {
          notify("没检测到局域网地址，请手动填写", false);
          return;
        }
        const next = normalizeServer("http://" + lan[0] + ":" + port);
        state.server = next;
        state.connected = false;
        ui.server.value = next;
        save("pgbridge.server", next);
        log("已自动填写局域网地址: " + next);
        notify("已切换为局域网地址：" + next, true);
        renderStatus();
        discoverServer().catch(() => {});
      } catch (err) {
        notify("获取局域网地址失败: " + ((err && err.message) || err), false);
      }
    });
    ui.reconnect.addEventListener("click", () => {
      state.connected = false;
      log("正在重新连接…");
      renderStatus();
      discoverServer().catch(() => {});
    });
    ui.download.addEventListener("click", () => {
      try {
        window.open("https://github.com/bluebird0212/pg-executor/releases/latest", "_blank");
      } catch (_) {}
    });
    ui.retrySetup.addEventListener("click", async () => {
      log("正在寻找本地服务…");
      const found = await discoverServer();
      if (found) {
        state.connected = true;
        state.lastError = "";
        log("已连接 " + state.server);
      } else {
        log("仍然没有找到，确认服务窗口是否还在运行");
      }
      renderStatus();
    });
    ui.copyHost.addEventListener("click", async () => {
      const ok = await copyText(apiBase());
      notify(ok ? "API 主机已复制：" + apiBase() : "复制失败，请手动选中复制", ok);
    });
    ui.copyKey.addEventListener("click", async () => {
      const ok = await copyText(state.apiKey);
      notify(ok ? "API Key 已复制" : "复制失败，请手动选中复制", ok);
    });
    ui.copyAll.addEventListener("click", async () => {
      const text = [
        "协议: Google Gemini",
        "API 主机: " + apiBase(),
        "API Key: " + state.apiKey,
      ].join("\n");
      const ok = await copyText(text);
      notify(ok ? "客户端连接信息已复制" : "复制失败，请手动复制", ok);
    });
    ui.historyBtn.addEventListener("click", () => {
      ui.history.classList.toggle("show");
      renderHistory();
    });
    ui.bootstrap.addEventListener("click", () => {
      log("开始手动引导…");
      bootstrap().catch((err) => log("引导失败: " + err.message));
    });
    ui.replay.addEventListener("click", () => {
      if (!state.caches.length) {
        log("当前没有缓存，先成功执行一次请求");
        return;
      }
      if (state.caches.length === 1) {
        armReplay(state.caches[0].id);
        return;
      }
      ui.cacheWrap.classList.add("show");
      renderCaches();
      log("有多份缓存，请在列表里选择要回放的那一份");
    });
    ui.cacheBtn.addEventListener("click", () => {
      ui.cacheWrap.classList.toggle("show");
      renderCaches();
    });
    ui.clear.addEventListener("click", () => {
      state.caches = [];
      state.replayArmed = false;
      state.replayCacheId = null;
      save("pgbridge.caches", "[]");
      save("pgbridge.cache", "");
      log("缓存已清空");
      renderCaches();
      renderStatus();
    });
    ui.autoBoot.addEventListener("click", () => {
      state.autoBootstrap = !state.autoBootstrap;
      save("pgbridge.autobootstrap", state.autoBootstrap ? "1" : "0");
      log("自动引导已" + (state.autoBootstrap ? "开启" : "关闭"));
      renderStatus();
    });
    ui.shield.addEventListener("click", async () => {
      state.shield.enabled = !state.shield.enabled;
      renderStatus();
      await saveShieldState();
      log("防路由护盾已" + (state.shield.enabled ? "开启" : "关闭"));
      notify("防路由护盾已" + (state.shield.enabled ? "开启（" + (state.shield.mode === "deep" ? "深度" : "标准") + "）" : "关闭"), true);
    });
    ui.keepalive.addEventListener("click", toggleKeepAlive);
    ui.logbtn.addEventListener("click", () => ui.log.classList.toggle("show"));
    ui.theme.addEventListener("click", () => {
      const order = ["auto", "light", "dark"];
      const next = order[(order.indexOf(state.themeMode) + 1) % order.length];
      state.themeMode = next;
      save("pgbridge.theme", next);
      applyTheme();
      log("主题已切换：" + next);
    });
    ui.copylog.addEventListener("click", () => {
      const text = [
        "Bluebird PG v" + VERSION,
        "页面: " + location.href,
        "服务: " + state.server + " (" + (state.connected ? "已连接" : "未连接") + ")",
        "签名: " + (waaReady() ? "就绪" : "未就绪"),
        "UA: " + navigator.userAgent,
        "--- 日志 ---",
        state.logs.join("\n"),
      ].join("\n");
      const done = (ok) => notify(ok ? "诊断信息和日志已复制" : "复制失败，请手动复制日志", ok);
      copyText(text).then(done).catch(() => done(false));
    });
    ui.openconsole.addEventListener("click", () => {
      try {
        window.open(state.server + "/", "_blank");
      } catch (_) {}
    });
    ui.collapse.addEventListener("click", () => {
      const hidden = ui.body.style.display === "none";
      ui.body.style.display = hidden ? "" : "none";
      ui.collapse.textContent = hidden ? "—" : "+";
    });
    renderStatus();
    renderLog();
    renderHistory();
    renderCaches();
    applyTheme();
  }

  function buildFallback(err) {
    if (document.getElementById("pg-bridge-fallback")) return;
    const el = document.createElement("div");
    el.id = "pg-bridge-fallback";
    el.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:320px;" +
      "background:#7a1f1f;color:#fff;padding:10px 14px;border-radius:10px;" +
      "font:13px/1.5 system-ui,-apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.4)";
    el.textContent = "Bluebird PG 已加载，但面板渲染失败：" + String((err && err.message) || err);
    (document.documentElement || document.body).appendChild(el);
  }

  function ensurePanel() {
    if (!document.documentElement && !document.body) return;
    if (state.panel && state.panel.isConnected) return;
    if (state.panel && state.panel.shadowRoot) {
      try {
        (document.documentElement || document.body).appendChild(state.panel);
        return;
      } catch (_) {}
    }
    try {
      buildPanel();
    } catch (err) {
      buildFallback(err);
    }
  }

  function armReplay(id) {
    const entry = state.caches.find((c) => c.id === id);
    if (!entry) return;
    state.replayArmed = true;
    state.replayCacheId = id;
    log("已准备：下一次请求将回放 " + new Date(entry.ts).toLocaleTimeString() + " 的缓存");
    renderCaches();
    renderStatus();
  }

  function renderCaches() {
    const ui = state.ui;
    if (!ui || !ui.cacheWrap) return;
    const box = ui.cacheWrap;
    box.textContent = "";
    if (!state.caches.length) {
      box.appendChild(h("div", { class: "hempty", text: "还没有缓存，成功执行一次请求后就会出现在这里" }));
      return;
    }
    for (const c of state.caches) {
      const armed = state.replayArmed && state.replayCacheId === c.id;
      const playBtn = h("button", {
        class: "mini" + (armed ? " on" : ""),
        type: "button",
        text: armed ? "已选" : "回放",
      });
      playBtn.addEventListener("click", () => armReplay(c.id));
      const delBtn = h("button", { class: "mini", type: "button", text: "🗑" });
      delBtn.addEventListener("click", () => {
        state.caches = state.caches.filter((x) => x.id !== c.id);
        if (state.replayCacheId === c.id) {
          state.replayArmed = false;
          state.replayCacheId = null;
        }
        try {
          save("pgbridge.caches", JSON.stringify(state.caches));
        } catch (_) {}
        renderCaches();
        renderStatus();
      });
      box.appendChild(
        h("div", { class: "hitem" }, [
          h("span", {
            class: "htime",
            text: new Date(c.ts).toLocaleTimeString(),
          }),
          h("span", {
            class: "hmodel",
            text: String(c.model || "未知模型").replace(/^models\//, ""),
          }),
          h("span", {
            class: "htok",
            text: Math.round((c.raw ? c.raw.length : 0) / 1024) + "KB",
          }),
          playBtn,
          delBtn,
        ])
      );
    }
  }

  function renderHistory() {
    const ui = state.ui;
    if (!ui || !ui.history) return;
    const box = ui.history;
    box.textContent = "";
    if (!state.history.length) {
      box.appendChild(h("div", { class: "hempty", text: "还没有请求记录" }));
      return;
    }
    for (const item of state.history.slice(0, 10)) {
      const model = String(item.model || "").replace(/^models\//, "");
      const ms = Math.max(0, Number(item.ms) || 0);
      box.appendChild(
        h("div", { class: "hitem", title: item.error || "" }, [
          h("span", {
            class: "hdot " + (item.ok ? "ok" : "bad"),
            text: item.ok ? "✓" : "✗",
          }),
          h("span", { class: "htime", text: new Date(item.ts).toLocaleTimeString() }),
          h("span", {
            class: "hmodel",
            text: (item.replay ? "[回放] " : "") + (model || "未知模型"),
          }),
          h("span", { class: "hms", text: (ms / 1000).toFixed(1) + "s" }),
          h("span", { class: "htok", text: item.total ? fmtNum(item.total) : "" }),
        ])
      );
    }
  }

  function renderStatus() {
    const ui = state.ui;
    if (!ui || !ui.dot) return;
    ui.dot.className =
      "dot " +
      (state.connected
        ? waaReady()
          ? "ok"
          : "warn"
        : state.connecting || state.discovering
          ? "warn"
          : "err");
    ui.conn.textContent = state.connected
      ? "已连接"
      : state.discovering
        ? "正在寻找本地服务…"
        : state.connecting
          ? "连接中…"
          : "未连接";
    if (ui.setup) ui.setup.classList.toggle("show", !state.connected);
    ui.waa.textContent = waaReady()
      ? "签名已就绪"
      : state.connected
        ? "签名未就绪 · 首次请求会自动引导"
        : "签名未就绪";
    ui.waa.style.color = waaReady() ? "var(--ok)" : "var(--muted)";
    if (ui.cacheInfo) {
      if (!state.caches.length) {
        ui.cacheInfo.textContent = "无";
      } else {
        const armed = state.replayArmed
          ? state.caches.find((c) => c.id === state.replayCacheId) || state.caches[0]
          : null;
        ui.cacheInfo.textContent =
          state.caches.length +
          " 份" +
          (armed ? " · 待回放 " + new Date(armed.ts).toLocaleTimeString() : "");
      }
    }
    if (ui.okCount) ui.okCount.textContent = String(state.stats.success);
    if (ui.badCount) ui.badCount.textContent = String(state.stats.fail);
    if (ui.apiHost) ui.apiHost.textContent = apiBase();
    if (ui.apiKey) ui.apiKey.textContent = state.apiKey;
    if (ui.tokenTotal) ui.tokenTotal.textContent = fmtNum(state.tokens.total);
    if (ui.tokenDetail) {
      const last = state.tokens.last;
      ui.tokenDetail.textContent = last
        ? "上次 " + fmtNum(last.prompt) + " in / " + fmtNum(last.completion) + " out"
        : "上次 —";
    }
    if (ui.counts) {
      ui.counts.textContent = "✓" + state.stats.success + " ✗" + state.stats.fail;
    }
    if (ui.lastError) {
      ui.lastError.textContent = state.lastError ? "⚠ " + state.lastError : "";
      ui.lastError.className = "errline" + (state.lastError ? " show" : "");
    }
    if (ui.taskState) {
      ui.taskState.textContent = state.currentTask ? "执行中" : "空闲";
      ui.taskState.title = state.currentTask ? String(state.currentTask.id) : "";
    }
    if (ui.taskStat) {
      ui.taskStat.className = "stat" + (state.currentTask ? " busy" : "");
    }
    ui.replay.disabled = !state.caches.length;
    ui.keepalive.textContent = state.keepAlive ? "🔔 保活中" : "🔔 保活";
    if (ui.autoBoot) {
      ui.autoBoot.textContent = state.autoBootstrap ? "✨ 自动引导·开" : "✨ 自动引导·关";
      ui.autoBoot.className = "btn" + (state.autoBootstrap ? " primary" : "");
    }
    if (ui.shield) {
      const on = !!state.shield.enabled;
      ui.shield.textContent = "🛡 防路由·" + (on ? (state.shield.mode === "deep" ? "深度" : "标准") : "关");
      ui.shield.className = "btn" + (on ? " primary" : "");
      ui.shield.title =
        "服务端防路由护盾：" +
        (on ? "已开启（" + (state.shield.mode === "deep" ? "深度" : "标准") + "）" : "已关闭") +
        "；防截断：" +
        (state.antiTruncate ? "开" : "关");
    }
    if (state.lastError && !state.connected) ui.conn.title = state.lastError;
    ui.dot.title = state.lastError || (state.connected ? "已连接本地服务" : "未连接本地服务");
  }

  function renderLog() {
    const ui = state.ui;
    if (!ui || !ui.log) return;
    ui.log.textContent = state.logs.slice(-40).join("\n");
    if (ui.log.classList.contains("show")) ui.log.scrollTop = ui.log.scrollHeight;
  }

  // ------------------------------------------------------------------
  // 启动
  // ------------------------------------------------------------------

  log("脚本已加载 v" + VERSION + "，目标页面 " + location.host);
  try {
    if (themeMedia) {
      if (themeMedia.addEventListener) themeMedia.addEventListener("change", applyTheme);
      else if (themeMedia.addListener) themeMedia.addListener(applyTheme);
    }
  } catch (_) {}
  startHookScanner();
  pollLoop();
  setTimeout(() => {
    if (!state.connected) discoverServer().catch(() => {});
  }, 1200);
  setInterval(renderStatus, 1000);
  // AI Studio 是 SPA，切换页面时可能重建 DOM：定时把面板重新挂回去
  setInterval(() => {
    try {
      ensurePanel();
    } catch (_) {}
  }, 2500);

  function boot() {
    try {
      ensurePanel();
      if (state.keepAlive) {
        startAudio();
        log("后台保活已恢复");
      }
    } catch (err) {
      buildFallback(err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
