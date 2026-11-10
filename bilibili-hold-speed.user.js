// ==UserScript==
// @name         B站 按住方向键倍速微调
// @namespace    bilibili-hold-speed
// @version      2.0.2
// @description  按住 ← / → 以倍速播放，按住期间用 ↑/↓ 以 0.25x 为步长微调（默认 0.5x ~ 3x）；松开按键恢复本轮加速前的倍速。短按 ← / → 保持 B 站原生的 ±5 秒快进。
// @author       local
// @match        https://www.bilibili.com/*
// @match        https://bilibili.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  if (window.__BHS_LOADED__) return;
  window.__BHS_LOADED__ = true;

  /* ============================ 常量 ============================ */

  // 判定「长按」的时长：短于该值是短按（快退/快进 5 秒），长于该值进入倍速
  const HOLD_DELAY = 300;
  // 按住 ↑/↓ 不放时，连续调节的最小间隔
  const REPEAT_INTERVAL = 100;
  // 短按 ← / → 的快进秒数（与 B 站原生一致）
  const SHORT_SEEK = 5;
  // 方向键识别：优先用 key / code，个别环境拿不到时退回 keyCode（含数字键盘）
  const KEY_MAP = [
    { name: "left", key: "ArrowLeft", keyCodes: [37, 100] },
    { name: "right", key: "ArrowRight", keyCodes: [39, 102] },
    { name: "up", key: "ArrowUp", keyCodes: [38, 104] },
    { name: "down", key: "ArrowDown", keyCodes: [40, 98] },
  ];
  const NUMPAD_MAP = { Numpad4: "left", Numpad6: "right", Numpad8: "up", Numpad2: "down" };

  function arrowName(e) {
    const k = e.key;
    const c = e.code;
    for (let i = 0; i < KEY_MAP.length; i++) {
      if (k === KEY_MAP[i].key || c === KEY_MAP[i].key) return KEY_MAP[i].name;
    }
    if (c && NUMPAD_MAP[c]) return NUMPAD_MAP[c];
    const kc = e.keyCode || e.which || 0;
    if (kc) {
      for (let i = 0; i < KEY_MAP.length; i++) {
        if (KEY_MAP[i].keyCodes.indexOf(kc) !== -1) return KEY_MAP[i].name;
      }
    }
    return null;
  }

  // 播放器容器（用于判断某个 <video> 是否属于主播放器）
  const TRIGGER_SELECTORS = [".bpx-player-container", "#bilibili-player", ".bpx-player-video-wrap"];
  const MIN_VIDEO_W = 160;
  const MIN_VIDEO_H = 90;

  const NATIVE_HINT_SELECTOR = ".bpx-player-three-playrate-hint";
  const HINT_HOST_SELECTORS = [".bpx-player-container", ".bpx-player-video-wrap", "#bilibili-player"];
  const STYLE_ID = "bhs-style";
  const HINT_CLASS = "bhs-hint";
  const ACTIVE_CLASS = "bhs-active";
  const SHOW_CLASS = "bhs-show";

  const DEFAULTS = {
    enabled: true,
    bothSides: true, // true: ← 和 → 都可用；false: 仅 →
    step: 0.25,
    max: 3,
    min: 0.5,
    startRate: 3, // 进入倍速时的起始倍速（有记忆值时以记忆值为准）
    remember: true,
    overlay: true,
    last: null, // 记住的倍速（仅作用于「按住期间」的起始值）
  };
  const STEP_OPTIONS = [0.1, 0.25, 0.5];
  const START_OPTIONS = [1, 1.5, 2, 2.5, 3];
  const MAX_OPTIONS = [1.5, 2, 2.5, 3, 4];
  const MIN_OPTIONS = [0.25, 0.5, 0.75, 1];
  const STORE_KEY = "bhs_config_v1";

  /* ============================ 设置存储 ============================ */

  const hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";

  function loadConfig() {
    let raw = null;
    try {
      raw = hasGM ? GM_getValue(STORE_KEY, null) : window.localStorage.getItem(STORE_KEY);
    } catch (e) {
      raw = null;
    }
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch (e) {
        raw = null;
      }
    }
    return Object.assign({}, DEFAULTS, raw && typeof raw === "object" ? raw : {});
  }

  function saveConfig() {
    const raw = JSON.stringify(cfg);
    try {
      if (hasGM) GM_setValue(STORE_KEY, raw);
      else window.localStorage.setItem(STORE_KEY, raw);
    } catch (e) {
      /* 存储不可用时静默降级为「仅本次会话有效」 */
    }
  }

  const cfg = loadConfig();

  /* ============================ 运行时状态 ============================ */

  const state = {
    mode: false, // 是否处于「按住倍速」状态
    video: null,
    target: null, // 当前目标倍速
    base: 1, // 按住之前的普通倍速
    adjusted: false, // 本次按住期间是否真的调过速
    held: new Set(), // 正被按住的触发键
    holdTimer: 0,
    lastAdjustAt: 0,
    flashTimer: 0,
    watchTimer: 0,
  };

  let cachedVideo = null;
  let hintEl = null;
  let hintHost = null;

  /* ============================ 倍速读写 ============================ */

  const mediaProto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
  const RATE_DESC = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, "playbackRate");
  const DEF_RATE_DESC = mediaProto && Object.getOwnPropertyDescriptor(mediaProto, "defaultPlaybackRate");
  const canPatch = !!(RATE_DESC && RATE_DESC.set && DEF_RATE_DESC && DEF_RATE_DESC.set);

  function readRate(el) {
    return canPatch ? RATE_DESC.get.call(el) : el.playbackRate;
  }

  // 直接调用原型上的 setter，绕开实例上的拦截器，避免递归
  function writeRate(el, value) {
    if (!(typeof value === "number" && isFinite(value) && value > 0)) return;
    if (canPatch) {
      RATE_DESC.set.call(el, value);
      DEF_RATE_DESC.set.call(el, value);
    } else {
      el.playbackRate = value;
      el.defaultPlaybackRate = value;
    }
  }

  function clampRate(value) {
    let v = Number(value);
    if (!isFinite(v) || v <= 0) v = 1;
    v = Math.min(cfg.max, Math.max(cfg.min, v));
    return Math.round(v * 100) / 100;
  }

  const patched = new WeakSet();

  // 在 <video> 实例上重定义 playbackRate / defaultPlaybackRate：
  // 按住期间，任何外部写入（B 站自己的逻辑、切换清晰度等）都会被改写成我们的目标倍速，
  // 因此不会出现两边互相覆盖或倍速闪烁。
  function patchVideo(el) {
    if (!canPatch || !el || patched.has(el)) return;
    patched.add(el);
    Object.defineProperty(el, "playbackRate", {
      configurable: true,
      enumerable: true,
      get() {
        return RATE_DESC.get.call(this);
      },
      set(value) {
        onExternalRateWrite(this, value);
      },
    });
    Object.defineProperty(el, "defaultPlaybackRate", {
      configurable: true,
      enumerable: true,
      get() {
        return DEF_RATE_DESC.get.call(this);
      },
      set(value) {
        onExternalRateWrite(this, value);
      },
    });
  }

  function onExternalRateWrite(el, value) {
    if (state.mode && el === state.video && state.target != null) {
      writeRate(el, state.target);
      return;
    }
    writeRate(el, value);
  }

  /* ============================ 播放器 / <video> 定位 ============================ */

  function inPlayer(el) {
    return !!(el && el.closest && el.closest(TRIGGER_SELECTORS.join(",")));
  }

  // 返回尺寸与「出现在视口中的面积」；尺寸过小视为无效
  function measure(el) {
    const r = el.getBoundingClientRect();
    if (r.width < MIN_VIDEO_W || r.height < MIN_VIDEO_H) return null;
    const iw = Math.max(0, Math.min(r.right, window.innerWidth || 0) - Math.max(r.left, 0));
    const ih = Math.max(0, Math.min(r.bottom, window.innerHeight || 0) - Math.max(r.top, 0));
    return { size: r.width * r.height, visible: iw * ih };
  }

  // 找到当前可用的 <video>；找不到（非播放器页面 / 直播页）时返回 null，此时脚本完全不动键盘。
  // 优先取「真正显示在屏幕上」的那个：切换清晰度时播放器会短暂插入一个离屏 <video>，
  // 此时若选错元素，倍速会加在一个用户看不见的实例上。
  function resolveVideo() {
    if (cachedVideo && cachedVideo.isConnected && inPlayer(cachedVideo)) {
      const m = measure(cachedVideo);
      if (m && m.visible > 0) return cachedVideo;
    }
    let bestVisible = null;
    let bestVisibleScore = 0;
    let bestAny = null;
    let bestAnyScore = 0;
    const list = document.querySelectorAll("video");
    for (let i = 0; i < list.length; i++) {
      const el = list[i];
      if (!(el instanceof HTMLMediaElement) || !el.isConnected || !inPlayer(el)) continue;
      const m = measure(el);
      if (!m) continue;
      if (m.visible > bestVisibleScore) {
        bestVisibleScore = m.visible;
        bestVisible = el;
      }
      if (m.size > bestAnyScore) {
        bestAnyScore = m.size;
        bestAny = el;
      }
    }
    // 播放器被滚出视口时所有候选的可见面积都是 0，此时退回「尺寸最大者」
    const best = bestVisible || bestAny;
    cachedVideo = best;
    if (best) patchVideo(best);
    return best;
  }

  /* ============================ 焦点判断 ============================ */

  function isEditableEl(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    return el.isContentEditable === true;
  }

  function inEditableContext(target) {
    return isEditableEl(target) || isEditableEl(document.activeElement);
  }

  /* ============================ 浮层 ============================ */

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      `.${HINT_CLASS}{position:absolute;right:12px;top:12px;`,
      "display:flex;flex-direction:column;align-items:flex-end;gap:2px;padding:8px 14px;border-radius:10px;",
      "background:rgba(0,0,0,.72);color:#fff;pointer-events:none;z-index:2147483000;opacity:0;",
      'font:600 26px/1.1 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
      "text-shadow:0 1px 3px rgba(0,0,0,.5);transition:opacity .18s ease;}",
      `.${HINT_CLASS}.${SHOW_CLASS}{opacity:1;}`,
      `.${HINT_CLASS} .bhs-sub{font-size:12px;font-weight:400;opacity:.75;}`,
      `html.${ACTIVE_CLASS} ${NATIVE_HINT_SELECTOR}{display:none !important;}`,
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  function hintHostEl() {
    if (hintHost && hintHost.isConnected) return hintHost;
    for (let i = 0; i < HINT_HOST_SELECTORS.length; i++) {
      const el = document.querySelector(HINT_HOST_SELECTORS[i]);
      if (el) {
        hintHost = el;
        return el;
      }
    }
    return null;
  }

  function ensureHintEl() {
    if (hintEl && hintEl.isConnected) return hintEl;
    ensureStyle();
    const host = hintHostEl();
    if (!host) return null;
    hintEl = document.createElement("div");
    hintEl.className = HINT_CLASS;
    const rate = document.createElement("div");
    rate.className = "bhs-rate";
    const sub = document.createElement("div");
    sub.className = "bhs-sub";
    hintEl.appendChild(rate);
    hintEl.appendChild(sub);
    if (getComputedStyle(host).position === "static") {
      // 宿主没有定位上下文时用固定定位，把浮层贴在播放器区域右上角
      const r = host.getBoundingClientRect();
      hintEl.style.position = "fixed";
      hintEl.style.right = Math.max(12, (window.innerWidth || r.right) - r.right + 12) + "px";
      hintEl.style.top = r.top + 12 + "px";
    }
    host.appendChild(hintEl);
    return hintEl;
  }

  function formatRate(v) {
    const n = Math.round(Number(v) * 100) / 100;
    if (!isFinite(n)) return "";
    return (Number.isInteger(n * 10) ? n.toFixed(1) : String(n)) + "x";
  }

  function showOverlay(rate, subText) {
    if (!cfg.overlay) return;
    const el = ensureHintEl();
    if (!el) return;
    const rateEl = el.querySelector(".bhs-rate");
    const subEl = el.querySelector(".bhs-sub");
    const text = formatRate(rate);
    if (rateEl && rateEl.textContent !== text) rateEl.textContent = text;
    if (subEl && subEl.textContent !== subText) subEl.textContent = subText;
    el.classList.add(SHOW_CLASS);
  }

  function hideOverlay() {
    if (hintEl) hintEl.classList.remove(SHOW_CLASS);
  }

  function setNativeHintHidden(hidden) {
    ensureStyle();
    document.documentElement.classList.toggle(ACTIVE_CLASS, !!hidden);
  }

  /* ============================ 长按流程 ============================ */

  function applyRate() {
    const el = state.video;
    if (!el || !el.isConnected || state.target == null) return;
    writeRate(el, state.target);
    showOverlay(state.target, "↑ 加速 · ↓ 减速");
  }

  function enterMode() {
    state.holdTimer = 0;
    if (state.mode) return;
    const el = state.video && state.video.isConnected ? state.video : resolveVideo();
    if (!el) return;
    state.video = el;
    patchVideo(el);
    state.base = readRate(el); // 每轮仅在临时改速前记录一次，避免按键连发覆盖原倍速
    state.mode = true;
    state.adjusted = false;
    state.target = clampRate(cfg.remember && typeof cfg.last === "number" ? cfg.last : cfg.startRate);
    applyRate();
    // 与 B 站原生一致：按住倍速时如果视频是暂停的，自动开始播放
    if (el.paused) {
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    }
    setNativeHintHidden(true);
    startWatch();
  }

  function exitMode() {
    if (!state.mode) return;
    const el = state.video;
    const target = state.target;
    const adjusted = state.adjusted;
    state.mode = false;
    state.target = null;
    state.video = null;
    stopWatch();
    setNativeHintHidden(false);
    if (cfg.remember && adjusted && typeof target === "number") {
      cfg.last = target;
      saveConfig();
    }
    // 恢复本轮临时加速前的实际倍速，不受临时倍速上下限影响
    const restore = state.base;
    if (el && el.isConnected) writeRate(el, restore);
    if (cfg.overlay) {
      showOverlay(restore, "已松开 · 恢复正常倍速");
      if (state.flashTimer) window.clearTimeout(state.flashTimer);
      state.flashTimer = window.setTimeout(function () {
        state.flashTimer = 0;
        hideOverlay();
      }, 600);
    } else {
      hideOverlay();
    }
  }

  function nudge(dir) {
    let el = state.video && state.video.isConnected ? state.video : resolveVideo();
    if (!el) return;
    if (el !== state.video) {
      state.video = el;
      patchVideo(el);
      writeRate(el, state.target);
    }
    if (state.target == null) state.target = clampRate(cfg.startRate);
    const next = clampRate(state.target + dir * cfg.step);
    if (next === state.target) {
      showOverlay(state.target, "↑ 加速 · ↓ 减速");
      return;
    }
    state.target = next;
    state.adjusted = true;
    applyRate();
  }

  function shortSeek(delta) {
    const el = resolveVideo();
    if (!el) return;
    state.video = el;
    if (state.flashTimer) {
      window.clearTimeout(state.flashTimer);
      state.flashTimer = 0;
    }
    let t = el.currentTime + delta;
    const d = el.duration;
    if (typeof d === "number" && isFinite(d) && d > 0) t = Math.min(t, Math.max(d - 0.1, 0));
    t = Math.max(t, 0);
    try {
      el.currentTime = t;
    } catch (e) {
      /* 直播等无法 seek 的场景忽略 */
    }
    // 与 B 站原生一致：快进/快退后如果是暂停状态则继续播放
    if (el.paused) {
      const p = el.play();
      if (p && typeof p.catch === "function") p.catch(function () {});
    }
  }

  // 按住期间定期确认 <video> 没有在切换清晰度/切 P 时被替换
  function startWatch() {
    stopWatch();
    state.watchTimer = window.setInterval(function () {
      if (!state.mode) return;
      const el = state.video;
      if (!el || !el.isConnected) {
        const next = resolveVideo();
        if (next) {
          state.video = next;
          patchVideo(next);
          writeRate(next, state.target);
        }
        return;
      }
      if (Math.abs(readRate(el) - state.target) > 0.001) writeRate(el, state.target);
    }, 400);
  }

  function stopWatch() {
    if (state.watchTimer) {
      window.clearInterval(state.watchTimer);
      state.watchTimer = 0;
    }
  }

  /* ============================ 键盘事件 ============================ */

  function isTriggerKey(name) {
    return name === "right" || (cfg.bothSides && name === "left");
  }

  // 注册在 window 捕获阶段：比 B 站自己（window 冒泡阶段）的处理函数更早拿到事件，
  // 因此可以完全接管这几个键，避免和 B 站的长按倍速 / 音量调节互相打架。
  function onKeyDown(e) {
    if (!cfg.enabled || e.isComposing) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const name = arrowName(e);
    if (!name) return;

    if (isTriggerKey(name)) {
      if (inEditableContext(e.target)) return; // 在输入框里：完全不管
      const el = resolveVideo();
      if (!el) return; // 非播放器页面：完全不管
      e.preventDefault();
      e.stopImmediatePropagation();
      if (state.held.has(name)) return; // 系统按键连发
      state.held.add(name);
      state.video = el;
      if (!state.mode && !state.holdTimer) {
        state.holdTimer = window.setTimeout(enterMode, HOLD_DELAY);
      }
      return;
    }

    if (name === "up" || name === "down") {
      if (!state.held.size) return; // 没按住触发键：交给 B 站调节音量
      e.preventDefault();
      e.stopImmediatePropagation();
      // 按住期间 ↑/↓ 直接进入调速（即使还没到 300ms）
      if (!state.mode) {
        if (state.holdTimer) {
          window.clearTimeout(state.holdTimer);
          state.holdTimer = 0;
        }
        enterMode();
      }
      if (!state.mode) return;
      if (e.repeat && performance.now() - state.lastAdjustAt < REPEAT_INTERVAL) return;
      state.lastAdjustAt = performance.now();
      nudge(name === "up" ? 1 : -1);
      return;
    }
  }

  function onKeyUp(e) {
    const name = arrowName(e);
    if (!name) return;

    if (state.held.has(name)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      state.held.delete(name);
      if (state.holdTimer) {
        window.clearTimeout(state.holdTimer);
        state.holdTimer = 0;
      }
      if (state.mode) {
        // 还有别的触发键按着就继续倍速，全部松开才恢复
        if (!state.held.size) exitMode();
        return;
      }
      // 短按：自己实现快进/快退，行为与 B 站原生一致
      if (!state.held.size) shortSeek(name === "right" ? SHORT_SEEK : -SHORT_SEEK);
      return;
    }

    if ((name === "up" || name === "down") && state.held.size) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function resetAll() {
    state.held.clear();
    if (state.holdTimer) {
      window.clearTimeout(state.holdTimer);
      state.holdTimer = 0;
    }
    if (state.mode) exitMode();
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", resetAll);
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) resetAll();
  });

  /* ============================ 设置菜单 ============================ */

  function cycle(list, value) {
    const i = list.indexOf(value);
    return list[(i < 0 ? 0 : i + 1) % list.length];
  }

  let menuIds = [];

  function refreshMenu() {
    if (typeof GM_registerMenuCommand !== "function") return;
    if (typeof GM_unregisterMenuCommand === "function") {
      for (let i = 0; i < menuIds.length; i++) {
        try {
          GM_unregisterMenuCommand(menuIds[i]);
        } catch (e) {
          /* 少数管理器不支持注销，忽略 */
        }
      }
    }
    menuIds = [];
    const add = function (label, fn) {
      try {
        menuIds.push(GM_registerMenuCommand(label, fn));
      } catch (e) {
        /* 忽略 */
      }
    };
    const onOff = function (v) {
      return v ? "开" : "关";
    };

    add("长按倍速微调：" + onOff(cfg.enabled), function () {
      cfg.enabled = !cfg.enabled;
      if (!cfg.enabled) resetAll();
      saveConfig();
      refreshMenu();
    });
    add("触发键：" + (cfg.bothSides ? "← 和 →" : "仅 →"), function () {
      cfg.bothSides = !cfg.bothSides;
      resetAll();
      saveConfig();
      refreshMenu();
    });
    add("起始倍速：" + cfg.startRate + "x", function () {
      cfg.startRate = cycle(START_OPTIONS, cfg.startRate);
      saveConfig();
      refreshMenu();
    });
    add("每档步长：" + cfg.step + "x", function () {
      cfg.step = cycle(STEP_OPTIONS, cfg.step);
      saveConfig();
      refreshMenu();
    });
    add("倍速上限：" + cfg.max + "x", function () {
      cfg.max = cycle(MAX_OPTIONS, cfg.max);
      if (cfg.min >= cfg.max) cfg.min = cfg.min / 2;
      saveConfig();
      refreshMenu();
    });
    add("倍速下限：" + cfg.min + "x", function () {
      cfg.min = cycle(MIN_OPTIONS, cfg.min);
      if (cfg.min >= cfg.max) cfg.max = cfg.min + cfg.step;
      saveConfig();
      refreshMenu();
    });
    add("记住上次倍速：" + onOff(cfg.remember), function () {
      cfg.remember = !cfg.remember;
      saveConfig();
      refreshMenu();
    });
    add("显示倍速浮层：" + onOff(cfg.overlay), function () {
      cfg.overlay = !cfg.overlay;
      if (!cfg.overlay) hideOverlay();
      saveConfig();
      refreshMenu();
    });
    add("清除记住的倍速", function () {
      cfg.last = null;
      saveConfig();
      refreshMenu();
    });
    add("恢复默认设置", function () {
      Object.assign(cfg, DEFAULTS);
      saveConfig();
      refreshMenu();
    });
  }

  refreshMenu();

  // 调试 / 自动化测试入口
  window.__BHS__ = {
    state: state,
    cfg: cfg,
    resolveVideo: resolveVideo,
    enterMode: enterMode,
    exitMode: exitMode,
  };
})();
