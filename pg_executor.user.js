// ==UserScript==
// @name         PG Bridge Executor
// @namespace    https://github.com/bluebird0212/pg-executor
// @version      1.0.0
// @description  在 AI Studio 页面里执行 Gemini 请求，把结果回传给本地 PG Bridge 服务。支持缓存回放。
// @author       bluebird0212
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
    return s.replace(/\/+$/, "");
  }

  const state = {
    server: normalizeServer(pick("pgbridge.server", "http://127.0.0.1:8090")),
    connected: false,
    connecting: false,
    lastError: "",
    serviceReady: false,
    headersReady: false,
    snapshotKey: null,
    suppressUntil: 0,
    suppressBudget: 0,
    polling: false,
    currentTask: null,
    replayArmed: false,
    cache: null,
    stats: { success: 0, fail: 0 },
    logs: [],
    panel: null,
    ui: {},
    audio: null,
    keepAlive: String(pick("pgbridge.keepalive", "0")) === "1",
  };

  try {
    const rawCache = pick("pgbridge.cache", "");
    if (rawCache) state.cache = JSON.parse(rawCache);
  } catch (_) {
    state.cache = null;
  }
  try {
    const rawStats = pick("pgbridge.stats", "");
    if (rawStats) state.stats = Object.assign(state.stats, JSON.parse(rawStats));
  } catch (_) {}

  // ------------------------------------------------------------------
  // 日志
  // ------------------------------------------------------------------

  function log(message) {
    const line = "[" + new Date().toLocaleTimeString() + "] " + message;
    state.logs.push(line);
    if (state.logs.length > 120) state.logs.shift();
    try {
      console.log("[PG-Bridge]", message);
    } catch (_) {}
    renderLog();
  }

  // ------------------------------------------------------------------
  // 与本地服务通信（GM_xmlhttpRequest 可绕过 https 页面的混合内容限制）
  // ------------------------------------------------------------------

  function request(method, path, body, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const opts = {
        method,
        url: state.server + path,
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
          reject(new Error("无法连接 " + state.server));
        },
        ontimeout() {
          reject(new Error("连接超时 " + state.server));
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

  function cacheSummary() {
    if (!state.cache || !state.cache.raw) return null;
    return {
      ts: state.cache.ts,
      model: state.cache.model,
      stream: !!state.cache.stream,
      bytes: state.cache.raw.length,
    };
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
            cache: cacheSummary(),
            stats: state.stats,
          },
          40000
        );
        state.connecting = false;
        if (resp.status === 204) {
          state.connected = true;
          state.lastError = "";
          delay = 400;
          continue;
        }
        if (resp.status !== 200 || !resp.data || !resp.data.task) {
          throw new Error("服务返回 " + resp.status);
        }
        state.connected = true;
        state.lastError = "";
        delay = 400;
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
        state.lastError = String((err && err.message) || err);
        await sleep(delay);
        delay = Math.min(5000, delay + 700);
      }
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
    state.cache = { ts: Date.now(), model, stream: !!stream, raw };
    try {
      save("pgbridge.cache", JSON.stringify(state.cache));
    } catch (err) {
      log("缓存保存失败: " + (err && err.message));
    }
  }

  function bumpStats(ok) {
    if (ok) state.stats.success += 1;
    else state.stats.fail += 1;
    try {
      save("pgbridge.stats", JSON.stringify(state.stats));
    } catch (_) {}
  }

  function splitChunks(text, size) {
    const out = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }

  async function replayTask(task) {
    const raw = state.cache && state.cache.raw;
    if (!raw) throw new Error("没有可用缓存");
    state.replayArmed = false;
    if (task.stream) {
      const pieces = splitChunks(raw, 4096);
      for (const piece of pieces) {
        await postResult({ id: task.id, kind: "chunk", chunkBody: piece });
      }
      await postResult({ id: task.id, kind: "end", status: 200 });
    } else {
      await postResult({ id: task.id, kind: "response", status: 200, rawResponse: raw });
    }
    bumpStats(true);
    log("缓存回放完成（" + raw.length + " 字符）");
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
    bumpStats(true);
    log("完成 " + task.id.slice(0, 8) + "（" + raw.length + " 字符）");
  }

  async function handleTask(task) {
    state.currentTask = task;
    renderStatus();
    try {
      if (state.replayArmed && state.cache && state.cache.raw) {
        log("使用缓存回放 " + String(task.id).slice(0, 8));
        await replayTask(task);
      } else {
        await executeTask(task);
      }
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
.wrap{--bg:#0f1217;--card:#161a21;--line:#252b36;--fg:#e7eaf0;--muted:#7b8494;--ok:#3ddc97;--warn:#f2b84b;--err:#ff6b6b;--accent:#6aa9ff;
font:12px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg)}
.card{width:min(360px,calc(100vw - 20px));background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 14px 40px rgba(0,0,0,.4)}
.head{display:flex;align-items:center;gap:8px;padding:9px 8px 9px 13px;background:var(--card);border-bottom:1px solid var(--line)}
.title{font-weight:650;font-size:13px}
.ver{color:var(--muted);font-size:10.5px}
.dot{margin-left:auto;width:8px;height:8px;border-radius:50%;background:var(--muted)}
.dot.ok{background:var(--ok);box-shadow:0 0 0 3px rgba(61,220,151,.18)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 3px rgba(242,184,75,.18)}
.dot.err{background:var(--err);box-shadow:0 0 0 3px rgba(255,107,107,.18)}
.ib{flex:none;width:26px;height:26px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:15px;cursor:pointer}
.ib:hover{background:#1d222b;color:var(--fg)}
.body{padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px;max-height:min(74vh,620px);overflow:auto}
.line{display:flex;gap:6px;align-items:center;color:var(--muted);font-size:11.5px}
.strong{color:var(--fg)}
.input{flex:1;min-width:0;height:30px;padding:0 9px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;font-size:13px}
.btn{height:28px;padding:0 10px;border-radius:7px;border:1px solid var(--line);background:var(--card);color:var(--fg);font:inherit;cursor:pointer;white-space:nowrap}
.btn:hover{background:#1d222b}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.warn{border-color:#5a4a22;color:var(--warn)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.hint{color:var(--muted);font-size:11px}
.log{display:none;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:7px 8px;font:10.5px/1.5 ui-monospace,Consolas,monospace;color:#9aa4b5}
.log.show{display:block}
.cache{display:none}
.cache.show{display:block}
`;

  function ensurePanel() {
    if (state.panel || !document.body) return;
    const host = document.createElement("div");
    host.id = "pg-bridge-panel";
    host.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
<div class="card">
  <div class="head">
    <span class="title">PG Bridge</span>
    <span class="ver">v${VERSION}</span>
    <span class="dot" id="dot"></span>
    <button class="ib" id="collapse" title="折叠">—</button>
  </div>
  <div class="body" id="body">
    <div class="line"><span>本地服务</span><span class="strong" id="conn">未连接</span><span id="waa"></span></div>
    <div class="line">
      <input class="input" id="server" spellcheck="false">
      <button class="btn" id="save">保存</button>
    </div>
    <div class="grid">
      <button class="btn primary" id="reconnect">重新连接</button>
      <button class="btn" id="bootstrap">手动引导</button>
      <button class="btn warn" id="replay">下次用缓存回放</button>
      <button class="btn" id="clear">清空缓存</button>
    </div>
    <div class="line"><span>缓存</span><span class="strong" id="cacheInfo">无</span></div>
    <div class="line"><span>使用</span><span class="strong" id="stats">成功 0 / 失败 0</span><span id="task"></span></div>
    <div class="line">
      <button class="btn" id="keepalive">后台保活</button>
      <button class="btn" id="logbtn">日志</button>
    </div>
    <div class="log" id="log"></div>
  </div>
</div>`;
    root.appendChild(style);
    root.appendChild(wrap);
    document.body.appendChild(host);
    state.panel = host;
    state.ui = {
      dot: root.getElementById("dot"),
      conn: root.getElementById("conn"),
      waa: root.getElementById("waa"),
      server: root.getElementById("server"),
      save: root.getElementById("save"),
      reconnect: root.getElementById("reconnect"),
      bootstrap: root.getElementById("bootstrap"),
      replay: root.getElementById("replay"),
      clear: root.getElementById("clear"),
      cacheInfo: root.getElementById("cacheInfo"),
      stats: root.getElementById("stats"),
      task: root.getElementById("task"),
      keepalive: root.getElementById("keepalive"),
      logbtn: root.getElementById("logbtn"),
      log: root.getElementById("log"),
      collapse: root.getElementById("collapse"),
      body: root.getElementById("body"),
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
    ui.reconnect.addEventListener("click", () => {
      state.connected = false;
      log("正在重新连接…");
      renderStatus();
    });
    ui.bootstrap.addEventListener("click", () => {
      log("开始手动引导…");
      bootstrap().catch((err) => log("引导失败: " + err.message));
    });
    ui.replay.addEventListener("click", () => {
      if (!state.cache || !state.cache.raw) {
        log("当前没有缓存，先成功执行一次请求");
        return;
      }
      state.replayArmed = true;
      log("已准备：下一次请求将直接回放缓存");
      renderStatus();
    });
    ui.clear.addEventListener("click", () => {
      state.cache = null;
      state.replayArmed = false;
      save("pgbridge.cache", "");
      log("缓存已清空");
      renderStatus();
    });
    ui.keepalive.addEventListener("click", toggleKeepAlive);
    ui.logbtn.addEventListener("click", () => ui.log.classList.toggle("show"));
    ui.collapse.addEventListener("click", () => {
      const hidden = ui.body.style.display === "none";
      ui.body.style.display = hidden ? "" : "none";
      ui.collapse.textContent = hidden ? "—" : "+";
    });
    renderStatus();
    renderLog();
  }

  function renderStatus() {
    const ui = state.ui;
    if (!ui || !ui.dot) return;
    ui.dot.className =
      "dot " + (state.connected ? (waaReady() ? "ok" : "warn") : state.connecting ? "warn" : "err");
    ui.conn.textContent = state.connected ? "已连接" : state.connecting ? "连接中…" : "未连接";
    ui.waa.textContent = waaReady() ? "· 签名已就绪" : "· 签名未就绪";
    ui.waa.style.color = waaReady() ? "#3ddc97" : "#7b8494";
    ui.cacheInfo.textContent =
      state.cache && state.cache.raw
        ? new Date(state.cache.ts).toLocaleTimeString() +
          " · " +
          state.cache.model +
          " · " +
          Math.round(state.cache.raw.length / 1024) +
          " KB" +
          (state.replayArmed ? " · 待回放" : "")
        : "无";
    ui.stats.textContent = "成功 " + state.stats.success + " / 失败 " + state.stats.fail;
    ui.task.textContent = state.currentTask ? "执行中 " + String(state.currentTask.id).slice(0, 8) : "";
    ui.replay.disabled = !(state.cache && state.cache.raw);
    ui.keepalive.textContent = state.keepAlive ? "保活已开" : "后台保活";
    if (state.lastError && !state.connected) ui.conn.title = state.lastError;
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

  startHookScanner();
  pollLoop();
  setInterval(renderStatus, 1000);

  function boot() {
    ensurePanel();
    if (state.keepAlive) {
      try {
        startAudio();
        log("后台保活已恢复");
      } catch (_) {}
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
