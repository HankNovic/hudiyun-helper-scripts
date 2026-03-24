// ==UserScript==
// @name         狐蒂云自动抢购
// @namespace    http://tampermonkey.net/
// @version      1.2.2
// @description  进入支付页或购物车提交后暂停，支持缩放到侧栏，含抢购时间提示，新增重复提交选项，自动关闭弹窗
// @match        https://www.szhdy.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /** ==========================
   * ⚙️ 默认配置
   * =========================== */
  const defaultConfig = {
    startTime: "2025-10-17 12:00:00",
    endTime: "2025-10-17 13:00:00",
    productIds: ["317", "345"],
    checkInterval: 800,
    minRandomInterval: 450,
    maxRandomInterval: 550,
    refreshAfterFails: 5,
    loopUntilSuccess: true,
    sidebarMode: false,
    // 检测模式：all_day 全天候检测；three_periods 平时三时间段
    detectMode: "three_periods",
    // 是否在购物车提交后重复提交订单（而不是暂停）
    repeatSubmitAfterCart: false,
    // 是否自动关闭弹窗
    autoClosePopup: true,
    // HTTP错误自动重试（仅 404/502），按检查间隔等待后刷新，最多5次；失败自动暂停
    enableHttpRetry: false,
    httpRetryMax: 5,
    // 在商品配置页(action=configureproduct)校验URL中的pid是否在商品ID数组中
    enforcePidWhitelistOnConfigPage: false
  };

  /** ==========================
   * 💾 配置处理
   * =========================== */
  const loadConfig = () => {
    try {
      const saved = JSON.parse(localStorage.getItem("hudiyun_config"));
      return saved ? { ...defaultConfig, ...saved } : defaultConfig;
    } catch {
      return defaultConfig;
    }
  };

  const saveConfig = (cfg) => {
    localStorage.setItem("hudiyun_config", JSON.stringify(cfg));
  };

  // 运行状态持久化
  const loadRunning = () => {
    try {
      const v = localStorage.getItem("hudiyun_running");
      return v === null ? null : v === "true";
    } catch {
      return null;
    }
  };
  const saveRunning = (val) => {
    try {
      localStorage.setItem("hudiyun_running", String(!!val));
    } catch {}
  };

  // 时间格式转换工具
  const toDateTimeLocalFormat = (timeStr) => {
    return timeStr.replace(' ', 'T').slice(0, 16);
  };

  const fromDateTimeLocalFormat = (dtStr) => {
    return dtStr.replace('T', ' ') + ':00';
  };

  const config = loadConfig();
  let failCount = 0;

  /** ==========================
   * 🧠 工具函数 + 页面判断
   * =========================== */
  
  // 检测并自动关闭弹窗
  const checkAndClosePopup = () => {
    if (!config.autoClosePopup) return false;
    const popupButton = document.querySelector('input[type="button"].layer-cancel[value="已阅读知晓"]');
    if (popupButton && popupButton.style.display !== 'none') {
      console.log('[狐蒂云] 检测到弹窗，自动点击关闭');
      popupButton.click();
      return true;
    }
    return false;
  };
  const isProtectedPage = () => {
    const url = location.href;
    return url.includes("action=configureproduct")
        || url.includes("action=viewcart")
        || url.includes("payment")
        || url.includes("pay");
  };

  const isPaymentPage = () => {
    const url = location.href;
    return url.includes("payment") || url.includes("pay");
  };

  const isCartPage = () => {
    return location.href.includes("action=viewcart");
  };

  // 商品配置页PID白名单检测（可选）
  const shouldStopByPidWhitelistOnConfigPage = () => {
    try {
      if (!config.enforcePidWhitelistOnConfigPage) return false;
      if (!location.href.includes("action=configureproduct")) return false;

      const params = new URLSearchParams(location.search);
      const currentPid = (params.get('pid') || '').trim();
      if (!currentPid) return true; // 无pid视为不通过

      const allowed = (config.productIds || []).map(x => String(x).trim()).filter(Boolean);
      return !allowed.includes(currentPid);
    } catch {
      return false;
    }
  };

  const sleep = (ms = null) => {
    const delay = ms || Math.floor(Math.random() * (config.maxRandomInterval - config.minRandomInterval + 1)) + config.minRandomInterval;
    return new Promise((r) => setTimeout(r, delay));
  };

  const now = () => new Date().getTime();
  const formatTime = (ts) => new Date(ts).toTimeString().split(" ")[0];
  const formatYmd = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const formatDateTimeFull = (d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
  };
  const formatDuration = (seconds) => {
    let sec = Math.max(0, Math.floor(Number(seconds) || 0));
    const h = Math.floor(sec / 3600);
    sec -= h * 3600;
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    const parts = [];
    if (h > 0) parts.push(`${h}小时`);
    if (m > 0 || h > 0) parts.push(`${m}分`);
    parts.push(`${s}秒`);
    return parts.join('');
  };
  const playSound = () => {
    try {
      const audio = new Audio("https://assets.mixkit.co/sfx/preview/mixkit-achievement-bell-600.mp3");
      audio.preload = "auto";
      audio.play().catch(() => console.warn("[狐蒂云] 请点击页面启用声音"));
    } catch (e) {
      console.error("[狐蒂云] 播放失败", e);
    }
  };

  playSound();

  const showNotify = (t, s = false) => {
    alert(`🎉 ${t}`);
    console.log(`[狐蒂云] ${t}`);
    if (s) playSound();
  };

  const waitFor = async (sel, t = isProtectedPage() ? 800 : 500) => {
    const s = Date.now();
    while (Date.now() - s < t) {
      const el = document.querySelector(sel);
      if (el) return el;
      await sleep(100);
    }
    return null;
  };

  // 基于本仓库提供的页面快照，判定“页面是否为正常的操作页（购物车/配置/商品列表）”
  const isValidPageContent = () => {
    try {
      // 购物车/结算相关关键元素
      const hasCartUI = document.querySelector('.submit-btn')
        || document.querySelector('.payment-checkbox')
        || document.querySelector('.sky-viewcart-terms-checkbox')
        || document.querySelector('.nextStep')
        || document.querySelector('.ordersummarybottom-title')
        || document.querySelector('.viewcart')
        || document.querySelector('.sky-cart-menu-item');

      if (hasCartUI) return true;

      // 配置/商品页常见元素
      const hasProductConfigUI = document.querySelector('.configureproduct')
        || document.querySelector('.btn-buyNow')
        || document.querySelector('.allocation-header-title h1')
        || document.querySelector('.os-card')
        || document.querySelector('[data-id] .form-footer-butt')
        || document.querySelector('a.form-footer-butt')
        || document.querySelector('a[href*="pid="]')
        || document.querySelector('a[href*="gid="]');

      return !!hasProductConfigUI;
    } catch {
      return false;
    }
  };

  // 仅针对本地特征（404/502）的HTML错误页检测：要求“页面空空且有明确标志”
  const detectHtmlError404or502 = () => {
    try {
      // 页面空空：无购物车/配置等关键UI
      const hasUI = isValidPageContent();
      if (hasUI) return null;
      // 仅基于 HTML 文本特征检测 404/502（不检测标题、不检测其他码）
      const bodyText = (document.body.innerText || document.body.textContent || '').trim();
      // 502：空页面并且包含 502 Bad Gateway 或 Tengine 的提示
      if (/\b502\b|Bad\s*Gateway/i.test(bodyText) || /Powered\s+by\s+Tengine/i.test(bodyText)) {
        return '502';
      }
      // 404：空页面并且包含 Not Found 或“抱歉找不到页面”
      if (/\b404\b|Not\s*Found|抱歉找不到页面/i.test(bodyText)) {
        return '404';
      }
      return null;
    } catch {
      return null;
    }
  };

  // 针对当前页面的重试计数键（优先使用pid）
  const getRetryKey = () => {
    try {
      const params = new URLSearchParams(location.search);
      const pid = params.get('pid');
      if (pid) return `hudiyun_buy_http_retry_pid_${pid}`;
      return `hudiyun_buy_http_retry_${location.pathname}${location.search}`;
    } catch {
      return 'hudiyun_buy_http_retry_generic';
    }
  };

  const loadRetryCount = () => {
    try {
      const v = localStorage.getItem(getRetryKey());
      return v ? parseInt(v) : 0;
    } catch {
      return 0;
    }
  };

  const saveRetryCount = (n) => {
    try {
      localStorage.setItem(getRetryKey(), String(n));
    } catch {}
  };

  const clearRetryCount = () => {
    try {
      localStorage.removeItem(getRetryKey());
    } catch {}
  };

  /** ==========================
   * 🧠 控制面板（新增抢购时间提示）
   * =========================== */
  let isRunning = loadRunning();
  if (isRunning === null) isRunning = true;
  const createPanel = () => {
    // 样式新增提示文字样式
    const style = document.createElement('style');
    style.textContent = `
      #hud-panel {
        font-family: system-ui, sans-serif;
        position: fixed;
        right: 0;
        bottom: 0;
        width: 300px;
        z-index: 99999;
        transition: width 0.3s ease;
      }
      #hud-panel.sidebar {
        width: 180px;
      }
      .hud-card {
        background: #1a1a1a;
        border-radius: 8px 0 0 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.3);
        color: #f0f0f0;
        overflow: hidden;
      }
      .hud-header {
        background: #333;
        padding: 8px 12px;
        font-weight: 500;
        font-size: 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      .scale-btn {
        cursor: pointer;
        font-size: 16px;
        padding: 0 4px;
      }
      .protected-tag, .payment-tag, .cart-tag {
        font-size: 10px;
        padding: 1px 4px;
        border-radius: 2px;
      }
      .protected-tag { background: #4cd964; color: #000; }
      .payment-tag { background: #ff9500; color: #000; }
      .cart-tag { background: #5856d6; color: white; }
      .hud-status, .hud-config {
        padding: 10px 12px;
        font-size: 12px;
      }
      .hud-status {
        border-bottom: 1px solid #333;
      }
      .status-item {
        margin: 4px 0;
        display: flex;
        justify-content: space-between;
      }
      .status-label { color: #aaa; }
      .status-running { color: #4cd964; }
      .status-paused { color: #ffcc00; }
      .status-ending { color: #ff3b30; }
      .status-protected { color: #00ccff; }
      /* 新增：抢购时间提示样式 */
      .rush-time-hint {
        color: #4cd964; /* 绿色提示色 */
        font-size: 11px;
        padding: 5px 0 8px;
        border-bottom: 1px dashed #444;
        margin-bottom: 8px;
      }
      .config-group {
        margin-bottom: 8px;
      }
      .config-label {
        display: block;
        color: #aaa;
        margin-bottom: 3px;
        font-size: 11px;
      }
      .config-input {
        width: 100%;
        padding: 5px 8px;
        background: #2a2a2a;
        border: 1px solid #444;
        border-radius: 4px;
        color: #f0f0f0;
        font-size: 12px;
        box-sizing: border-box;
      }
      .config-input:focus {
        outline: none;
        border-color: #4cd964;
      }
      .config-checkbox-label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        color: #aaa;
        font-size: 12px;
        user-select: none;
        padding: 2px 0;
        width: auto;
        margin: 0;
      }
      .config-checkbox-label:hover { color: #f0f0f0; }
      .config-checkbox-label input[type="checkbox"] {
        margin: 0;
        cursor: pointer;
        width: auto;
        flex-shrink: 0;
        vertical-align: middle;
        position: relative;
        outline: none;
      }
      .config-checkbox-label input[type="checkbox"]:focus { outline: none; box-shadow: none; }
      input[type="datetime-local"] {
        color-scheme: dark;
        font-size: 11px;
      }
      .hud-actions {
        display: flex;
        padding: 8px 12px;
        gap: 5px;
        background: #222;
      }
      .hud-btn {
        flex: 1;
        padding: 5px 0;
        border: none;
        border-radius: 4px;
        font-size: 12px;
        cursor: pointer;
      }
      .hud-btn.toggle { background: #4cd964; color: #000; }
      .hud-btn.save { background: #ffcc00; color: #000; }
      .hud-btn.refresh {
        background: #ff3b30;
        color: white;
        opacity: var(--refresh-opacity, 1);
        pointer-events: var(--refresh-events, auto);
      }
      .hud-btn:active { opacity: 0.8; }
      /* 侧栏模式隐藏配置区（含提示文字）和操作区 */
      #hud-panel.sidebar .hud-config,
      #hud-panel.sidebar .hud-actions {
        display: none;
      }
    `;
    document.head.appendChild(style);

    const p = document.createElement("div");
    p.id = "hud-panel";
    if (config.sidebarMode) p.classList.add("sidebar");

    const isProtected = isProtectedPage();
    const isPayment = isPaymentPage();
    const isCart = isCartPage();

    if (isPayment) {
      isRunning = false;
      saveRunning(false);
    }

    p.innerHTML = `
      <div class="hud-card">
        <div class="hud-header">
          狐蒂云自动抢购
          <span class="scale-btn" id="scale-btn">${config.sidebarMode ? '→' : '←'}</span>
          ${isPayment ? '<span class="payment-tag">支付页</span>' :
            isCart ? '<span class="cart-tag">购物车</span>' :
            (isProtected ? '<span class="protected-tag">保护页</span>' : '')}
        </div>

        <div class="hud-status">
          <div class="status-item">
            <span class="status-label">状态：</span>
            <span id="hud-status" class="${isPayment ? 'status-paused' :
              isCart ? (isRunning ? 'status-protected' : 'status-paused') :
              (isProtected ? 'status-protected' : 'status-running')}">
              ${isPayment ? '已暂停(支付页)' :
                isCart ? (isRunning ? '购物车(运行中)' : '已暂停(已提交)') :
                (isProtected ? '保护页(不刷新)' : '运行中')}
            </span>
          </div>
          <div class="status-item">
            <span class="status-label">时间：</span>
            <span id="hud-time"></span>
          </div>
          <div class="status-item">
            <span class="status-label">剩余：</span>
            <span id="hud-countdown"></span>
          </div>
          <div class="status-item">
            <span class="status-label">检测：</span>
            <span id="hud-check"></span>
          </div>
        </div>

        <!-- 配置区：新增抢购时间提示（侧栏模式隐藏） -->
        <div class="hud-config">
          <div class="config-group">
            <label class="config-label">检测模式</label>
            <div id="cfg-detect-mode" style="display:flex; gap:10px; align-items:center;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="radio" name="detectMode" value="all_day" ${config.detectMode === 'all_day' ? 'checked' : ''}>
                全天候检测
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;">
                <input type="radio" name="detectMode" value="three_periods" ${config.detectMode === 'three_periods' ? 'checked' : ''}>
                平时三时间段
              </label>
            </div>
          </div>
          <!-- 新增内容：抢购时间提示 -->
          <div class="rush-time-hint" id="rush-hint">
            ${config.detectMode === 'all_day' ? '抢购时间为：0-24点' : '抢购时间为：早上7-9点，中午1-2点，晚上5-7点'}
          </div>

          <div class="config-group">
            <label class="config-label">开始时间</label>
            <input id="cfg-start" type="datetime-local" value="${toDateTimeLocalFormat(config.startTime)}" class="config-input">
          </div>
          <div class="config-group" id="cfg-end-group" style="${config.detectMode==='all_day' ? 'display:none;' : ''}">
            <label class="config-label">结束时间</label>
            <input id="cfg-end" type="datetime-local" value="${toDateTimeLocalFormat(config.endTime)}" class="config-input">
          </div>
          <div class="config-group">
            <label class="config-label">商品ID (逗号分隔)</label>
            <input id="cfg-pid" type="text" value="${config.productIds.join(',')}" class="config-input">
          </div>
          <div style="display: flex; gap: 8px;">
            <div class="config-group" style="flex: 1;">
              <label class="config-label">检查间隔(ms)</label>
              <input id="cfg-interval" type="number" value="${config.checkInterval}" class="config-input">
            </div>
            <div class="config-group" style="flex: 1;">
              <label class="config-label">刷新阈值(次)</label>
              <input id="cfg-refresh" type="number" value="${config.refreshAfterFails}" class="config-input">
            </div>
          </div>
          <div class="config-group">
            <label class="config-checkbox-label">
              <input type="checkbox" id="cfg-repeat-submit" ${config.repeatSubmitAfterCart ? 'checked' : ''}>
              购物车提交后重复提交订单（不暂停）
            </label>
          </div>
          <div class="config-group">
            <label class="config-checkbox-label">
              <input type="checkbox" id="cfg-auto-close-popup" ${config.autoClosePopup ? 'checked' : ''}>
              自动关闭弹窗
            </label>
          </div>
          <div class="config-group">
            <label class="config-checkbox-label">
              <input type="checkbox" id="cfg-http-retry" ${config.enableHttpRetry ? 'checked' : ''}>
              HTTP错误自动重试（仅404/502，最多5次）
            </label>
          </div>
          <div class="config-group">
            <label class="config-checkbox-label">
              <input type="checkbox" id="cfg-enforce-pid-whitelist" ${config.enforcePidWhitelistOnConfigPage ? 'checked' : ''}>
              商品页校验PID（不在商品ID数组则停止）
            </label>
          </div>
        </div>

        <div class="hud-actions">
          <button id="hud-toggle" class="hud-btn toggle">
            ${isRunning ? '暂停' : '开始'}
          </button>
          <button id="hud-save" class="hud-btn save">保存</button>
          <button id="hud-refresh" class="hud-btn refresh">刷新</button>
        </div>
      </div>
    `;
    document.body.appendChild(p);

    if (isProtected) {
      const refreshBtn = document.querySelector("#hud-refresh");
      refreshBtn.style.setProperty('--refresh-opacity', '0.5');
      refreshBtn.style.setProperty('--refresh-events', 'none');
    }

    // 缩放按钮事件
    const scaleBtn = document.querySelector("#scale-btn");
    scaleBtn.addEventListener("click", () => {
      const panel = document.querySelector("#hud-panel");
      config.sidebarMode = !config.sidebarMode;
      if (config.sidebarMode) {
        panel.classList.add("sidebar");
        scaleBtn.textContent = '→';
      } else {
        panel.classList.remove("sidebar");
        scaleBtn.textContent = '←';
      }
      saveConfig(config);
    });

    // 原有按钮事件
    document.querySelector("#hud-toggle").addEventListener("click", () => {
      isRunning = !isRunning;
      saveRunning(isRunning);
      const btn = document.querySelector("#hud-toggle");
      const statusEl = document.querySelector("#hud-status");
      const isProtected = isProtectedPage();
      const isPayment = isPaymentPage();
      const isCart = isCartPage();

      btn.textContent = isRunning ? "暂停" : "开始";
      if (isRunning) {
        btn.className = "hud-btn toggle";
        if (isPayment) {
          statusEl.className = "status-paused";
          statusEl.textContent = "已暂停(支付页)";
        } else if (isCart) {
          statusEl.className = "status-protected";
          statusEl.textContent = "购物车(运行中)";
        } else {
          statusEl.className = isProtected ? "status-protected" : "status-running";
          statusEl.textContent = isProtected ? "保护页(不刷新)" : "运行中";
        }
      } else {
        btn.className = "hud-btn toggle status-paused";
        statusEl.className = "status-paused";
        statusEl.textContent = isPayment ? "已暂停(支付页)" : isCart ? "已暂停(已提交)" : "已暂停";
      }
    });

    document.querySelector("#hud-save").addEventListener("click", () => {
      config.startTime = fromDateTimeLocalFormat(document.querySelector("#cfg-start").value);
      config.endTime = fromDateTimeLocalFormat(document.querySelector("#cfg-end").value);
      config.productIds = document.querySelector("#cfg-pid").value.split(/[，,]/).map(x => x.trim()).filter(Boolean);
      config.checkInterval = parseInt(document.querySelector("#cfg-interval").value) || 800;
      config.refreshAfterFails = parseInt(document.querySelector("#cfg-refresh").value) || 5;
      config.repeatSubmitAfterCart = document.querySelector("#cfg-repeat-submit").checked;
      config.autoClosePopup = document.querySelector("#cfg-auto-close-popup").checked;
      config.enableHttpRetry = document.querySelector("#cfg-http-retry").checked;
      config.enforcePidWhitelistOnConfigPage = document.querySelector("#cfg-enforce-pid-whitelist").checked;
      const sel = document.querySelector('#cfg-detect-mode');
      const checked = sel?.querySelector('input[name="detectMode"]:checked')?.value;
      if (checked === 'all_day' || checked === 'three_periods') config.detectMode = checked;
      saveConfig(config);

      const saveBtn = document.querySelector("#hud-save");
      const originalText = saveBtn.textContent;
      saveBtn.textContent = "已保存，刷新中...";
      setTimeout(() => {
        saveBtn.textContent = originalText;
        if (!isProtectedPage()) location.reload();
      }, 500);
    });
    // 自动保存配置的通用函数
    const autoSaveConfig = () => {
      config.startTime = fromDateTimeLocalFormat(document.querySelector("#cfg-start").value);
      if (config.detectMode !== 'all_day') {
        config.endTime = fromDateTimeLocalFormat(document.querySelector("#cfg-end").value);
      }
      config.productIds = document.querySelector("#cfg-pid").value.split(",").map(x => x.trim());
      config.checkInterval = parseInt(document.querySelector("#cfg-interval").value) || 800;
      config.refreshAfterFails = parseInt(document.querySelector("#cfg-refresh").value) || 5;
      config.repeatSubmitAfterCart = document.querySelector("#cfg-repeat-submit").checked;
      config.autoClosePopup = document.querySelector("#cfg-auto-close-popup").checked;
      config.enableHttpRetry = document.querySelector("#cfg-http-retry").checked;
      config.enforcePidWhitelistOnConfigPage = document.querySelector("#cfg-enforce-pid-whitelist").checked;
      saveConfig(config);
      
      // 显示短暂保存提示
      const saveBtn = document.querySelector("#hud-save");
      const originalText = saveBtn.textContent;
      saveBtn.textContent = "已自动保存";
      saveBtn.style.opacity = "0.7";
      setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.opacity = "1";
      }, 800);
    };

    // 动态更新提示文案 + 自动保存（单选变更）
    const modeSelect = document.querySelector('#cfg-detect-mode');
    modeSelect?.addEventListener('change', () => {
      const v = modeSelect.querySelector('input[name="detectMode"]:checked')?.value;
      const hint = document.querySelector('#rush-hint');
      if (v === 'all_day') {
        hint.textContent = '抢购时间为：0-24点';
        // 设置开始时间为当前并隐藏结束时间
        const nowStr = formatDateTimeFull(new Date());
        config.startTime = nowStr;
        const startInput = document.querySelector('#cfg-start');
        if (startInput) startInput.value = toDateTimeLocalFormat(nowStr);
        const endGroup = document.querySelector('#cfg-end-group');
        if (endGroup) endGroup.style.display = 'none';
      } else {
        hint.textContent = '抢购时间为：早上7-9点，中午1-2点，晚上5-7点';
        const endGroup = document.querySelector('#cfg-end-group');
        if (endGroup) endGroup.style.display = '';
      }
      if (v === 'all_day' || v === 'three_periods') {
        config.detectMode = v;
        autoSaveConfig();
      }
    });

    // 为所有输入框添加自动保存
    document.querySelectorAll('#cfg-start, #cfg-end, #cfg-pid, #cfg-interval, #cfg-refresh').forEach(el => {
      el.addEventListener('change', autoSaveConfig);
    });

    // 为复选框添加自动保存
    document.querySelectorAll('#cfg-repeat-submit, #cfg-auto-close-popup, #cfg-http-retry, #cfg-enforce-pid-whitelist').forEach(el => {
      el.addEventListener('change', autoSaveConfig);
    });

    document.querySelector("#hud-refresh").addEventListener("click", () => {
      if (isProtectedPage()) return;
      document.querySelector("#hud-check").textContent = "正在刷新...";
      setTimeout(() => location.reload(), 500);
    });
  };

  /** ==========================
   * 🧠 面板更新
   * =========================== */
  const updatePanel = (status, info = "") => {
    const nowTime = formatTime(Date.now());
    let targetTs;
    if (config.detectMode === 'all_day') {
      targetTs = new Date(config.endTime.replace(/-/g, "/")).getTime();
    } else {
      // three_periods: 如果处于窗口内，倒计时至窗口结束；否则倒计时至下一窗口开始
      const { start, end } = getNextThreePeriodWindow();
      targetTs = (now() >= start && now() < end) ? end : start;
    }
    const leftSec = Math.max(0, ((targetTs - now()) / 1000).toFixed(0));
    const statusEl = document.querySelector("#hud-status");
    const isProtected = isProtectedPage();
    const isPayment = isPaymentPage();
    const isCart = isCartPage();

    if (isPayment) {
      statusEl.className = "status-paused";
      statusEl.textContent = "已暂停(支付页)";
      document.querySelector("#hud-check").textContent = "已暂停操作";
    } else if (isCart) {
      statusEl.className = isRunning ? "status-protected" : "status-paused";
      statusEl.textContent = isRunning ? "购物车(运行中)" : "已暂停(已提交)";
      document.querySelector("#hud-check").textContent = `[购物车] ${info}`;
    } else if (isProtected) {
      statusEl.className = "status-protected";
      statusEl.textContent = "保护页(不刷新)";
      document.querySelector("#hud-check").textContent = `[保护页] ${info}`;
    } else {
      // 全天候模式下使用更通俗的状态与倒计时文案
      if (config.detectMode === 'all_day') {
        statusEl.className = "status-running";
        statusEl.textContent = "全天候(运行中)";
        document.querySelector("#hud-check").textContent = info || "正在检测商品";
        document.querySelector("#hud-countdown").textContent = `全天候：0-24点`;
        document.querySelector("#hud-time").textContent = nowTime;
        return;
      }

      // 非全天候，保持原样
      statusEl.className = status.includes("结束") ? "status-ending"
        : status.includes("暂停") ? "status-paused"
        : "status-running";
      statusEl.textContent = status;
      document.querySelector("#hud-check").textContent = `${info} (${failCount}/${config.refreshAfterFails})`;
    }

    document.querySelector("#hud-time").textContent = nowTime;
    document.querySelector("#hud-countdown").textContent = `${leftSec}s`;
  };

  /** ==========================
   * 🦊 核心逻辑
   * =========================== */
  // 计算下一次三时间段窗口：7-9, 13-14, 17-19（本地时区）
  const getNextThreePeriodWindow = () => {
    const nowDate = new Date();
    const ymd = formatYmd(nowDate);
    const mk = (h) => new Date(`${ymd} ${String(h).padStart(2,'0')}:00:00`.replace(/-/g,'/')).getTime();
    const windows = [
      { start: mk(7), end: mk(9) },
      { start: mk(13), end: mk(14) },
      { start: mk(17), end: mk(19) }
    ];
    const current = now();
    for (const w of windows) {
      if (current < w.end) {
        if (current <= w.start) return w; // upcoming
        return w; // within window
      }
    }
    // all passed today → move to tomorrow's first window
    const tomorrow = new Date(nowDate.getTime() + 24*60*60*1000);
    const ymd2 = formatYmd(tomorrow);
    return { start: new Date(`${ymd2} 07:00:00`.replace(/-/g,'/')).getTime(), end: new Date(`${ymd2} 09:00:00`.replace(/-/g,'/')).getTime() };
  };

  // 根据模式等待到可检测窗口
  const waitUntilTimeRange = async () => {
    if (config.detectMode === 'all_day') {
      // 全天候：不等待开始/结束，直接运行
      updatePanel("全天候(运行中)", "正在检测商品");
      return;
    }

    // three_periods
    while (true) {
      if (!isRunning) return;
      const { start, end } = getNextThreePeriodWindow();
      if (now() < start) {
        const left = ((start - now()) / 1000).toFixed(1);
        updatePanel("等待三时间段", `下个窗口 ${formatTime(start)}，剩余 ${left}s`);
        await sleep(500);
        continue;
      }
      if (now() >= start && now() < end) {
        updatePanel("抢购中(三段)", `窗口 ${formatTime(start)}-${formatTime(end)}`);
        return; // 进入检测循环
      }
      // 如果恰好越过 end，循环重新计算下个窗口
      await sleep(300);
    }
  };

  const restartIfNeeded = () => {
    if (isProtectedPage()) {
      updatePanel("保护页", "加载失败");
      return;
    }

    if (config.loopUntilSuccess) {
      updatePanel("重试中", "刷新页面...");
      setTimeout(() => location.reload(), config.checkInterval);
    }
  };

  const autoRefreshIfNeeded = () => {
    if (isProtectedPage()) return true;

    failCount++;
    if (failCount >= config.refreshAfterFails) {
      updatePanel("刷新中", `连续${failCount}次未发现`);
      setTimeout(() => location.reload(), 500);
      return true;
    }
    return false;
  };

  const tryBuyProduct = async () => {
    // 支持多种结构：
    // 1) 容器上有 data-id
    // 2) 直接存在 a.form-footer-butt 且 href 带 pid/gid
    // 3) 任意元素带 data-gid / data-id 等
    for (const pid of config.productIds) {
      const targetPid = String(pid).trim();

      // 直接按钮匹配 href 中的 pid/gid
      const directBtn = document.querySelector(`.form-footer-butt[href*="pid=${targetPid}"]`) 
        || document.querySelector(`.form-footer-butt[href*="gid=${targetPid}"]`)
        || document.querySelector(`a[href*="pid=${targetPid}"]`)
        || document.querySelector(`a[href*="gid=${targetPid}"]`);

      // 容器匹配 data-id/data-gid，然后在内部找按钮
      const container = document.querySelector(`[data-id="${targetPid}"]`) 
        || document.querySelector(`[data-gid="${targetPid}"]`);
      const innerBtn = container ? (container.querySelector('.form-footer-butt') 
        || container.querySelector('a[href*="pid="]') 
        || container.querySelector('a[href*="gid="]')) : null;

      const button = directBtn || innerBtn;
      if (!button) continue;

      const txt = (button.textContent || '').trim();
      if (txt && (txt.includes('售罄') || txt.includes('结束'))) {
        updatePanel('抢购中', `ID=${targetPid} 售罄`);
        continue;
      }

      failCount = 0;
      updatePanel('抢购中', `点击购买 ID=${targetPid}`);
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;
    }
    return false;
  };

  const doIt = async () => {
    createPanel();
    
    // 页面加载时检测并关闭弹窗
    checkAndClosePopup();

    if (isPaymentPage()) {
      updatePanel("", "已暂停操作");
      return;
    }

    // HTTP错误自动重试：仅在“启用 + 非支付页 + 运行中”时检查，暂停时不触发
    if (config.enableHttpRetry && !isPaymentPage() && isRunning) {
      const htmlError = detectHtmlError404or502();
      if (htmlError) {
        const current = loadRetryCount();
        if (current < (config.httpRetryMax || 5)) {
          saveRetryCount(current + 1);
          updatePanel("错误重试中", `检测到页面错误(${htmlError})，${current + 1}/${config.httpRetryMax} 次，等待后刷新...`);
          setTimeout(() => location.reload(), config.checkInterval);
          return;
        } else {
          // 超过最大重试次数 → 自动暂停
          isRunning = false;
          saveRunning(false);
          clearRetryCount();
          const toggle = document.querySelector("#hud-toggle");
          if (toggle) {
            toggle.textContent = "开始";
            toggle.className = "hud-btn toggle status-paused";
          }
          updatePanel("已暂停", `页面错误(${htmlError}) 重试超过${config.httpRetryMax}次，已自动暂停`);
          return;
        }
      } else {
        // 非错误页 → 清理计数
        clearRetryCount();
      }
    }

    await waitUntilTimeRange();
    const url = location.href;

    const runLoop = async () => {
      // 优先检测并关闭弹窗
      checkAndClosePopup();
      
      if (isPaymentPage()) {
        isRunning = false;
        saveRunning(false);
        updatePanel("", "已暂停操作");
        document.querySelector("#hud-toggle").textContent = "开始";
        document.querySelector("#hud-toggle").className = "hud-btn toggle status-paused";
        return;
      }

      if (shouldStopByPidWhitelistOnConfigPage()) {
        isRunning = false;
        saveRunning(false);
        const toggle = document.querySelector("#hud-toggle");
        if (toggle) {
          toggle.textContent = "开始";
          toggle.className = "hud-btn toggle status-paused";
        }
        const params = new URLSearchParams(location.search);
        const currentPid = (params.get('pid') || '').trim();
        updatePanel("已暂停", `商品页PID不在白名单：${currentPid || '空'}`);
        return;
      }

      if (!isRunning) {
        updatePanel("已暂停", "等待恢复");
        setTimeout(runLoop, 500);
        return;
      }

      // 动态结束判断
      if (config.detectMode !== 'all_day') {
        // 三时间段：窗口结束则等待下个窗口并继续
        const { start, end } = getNextThreePeriodWindow();
        if (now() >= end) {
          await waitUntilTimeRange();
        }
      }

      // 若页面存在商品卡片与按钮，即进入通用检测分支（不再依赖特定 URL）
      const hasProductList = document.querySelector('[data-id] .form-footer-butt');
      if (hasProductList || url.includes("activities/default.html?method=activity")) {
        // 正常页面路径上，清理错误重试计数
        clearRetryCount();
        const success = await tryBuyProduct();
        if (success) {
          await sleep(1000);
        } else {
          const refreshed = autoRefreshIfNeeded();
          if (!refreshed) {
            updatePanel("抢购中", `未发现商品`);
          } else {
            return;
          }
        }
      }
      else if (url.includes("action=configureproduct")) {
        failCount = 0;
        updatePanel("保护页", "尝试加入购物车");
        const btn = await waitFor(".btn-buyNow");
        if (btn) {
          btn.click();
          await sleep(1500);
        } else {
          clearRetryCount();
          restartIfNeeded();
        }
      }
      else if (url.includes("action=viewcart")) {
        failCount = 0;
        updatePanel("购物车", "准备提交订单");

        const nextStep = await waitFor(".nextStep");
        if (nextStep) {
          nextStep.click();
          await sleep(800);
        }

        const pay = document.querySelector(".payment-checkbox");
        const sure = document.querySelector(".sky-viewcart-terms-checkbox");
        if (pay) pay.checked = true;
        if (sure) sure.checked = true;

        const submit = await waitFor(".submit-btn");
        if (submit) {
          submit.click();
          if (config.repeatSubmitAfterCart) {
            updatePanel("购物车", "订单已提交，继续重复提交");
            await sleep(2000); // 等待页面响应
          } else {
            updatePanel("购物车", "订单已提交，自动暂停");
            isRunning = false;
            saveRunning(false);
            document.querySelector("#hud-toggle").textContent = "开始";
            document.querySelector("#hud-toggle").className = "hud-btn toggle status-paused";
            return;
          }
        } else {
          clearRetryCount();
          restartIfNeeded();
        }
      }
      else {
        failCount = 0;
        updatePanel("空闲", "等待检测");
        clearRetryCount();
      }

      setTimeout(runLoop, config.checkInterval);
    };

    runLoop();
  };

  if (document.readyState === "complete") {
    doIt();
  } else {
    window.addEventListener("load", doIt);
  }
})();