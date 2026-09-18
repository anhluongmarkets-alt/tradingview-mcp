/**
 * Core health/discovery/launch logic.
 */
import { getClient, getTargetInfo, evaluate, disconnect, isChartTarget, getCdpTimeoutMs, KNOWN_PATHS } from '../connection.js';
import { existsSync } from 'fs';
import * as data from './data.js';
import { execSync, spawn } from 'child_process';

function classifyConnectionError(err) {
  if (err?.code === 'renderer_unresponsive') return 'renderer_unresponsive';
  if (err?.code === 'mcp_disconnected') return 'mcp_disconnected';
  const message = err?.message || String(err || '');
  if (/CDP|connection|ECONNREFUSED|fetch failed|not running|disconnected/i.test(message)) return 'mcp_disconnected';
  return 'health_check_failed';
}

export async function healthCheck({ _deps } = {}) {
  const acquireClient = _deps?.getClient || getClient;
  const acquireTarget = _deps?.getTargetInfo || getTargetInfo;
  const runEvaluate = _deps?.evaluate || evaluate;
  try {
    await acquireClient();
    const target = await acquireTarget();
    const targetIsChart = isChartTarget(target);

    if (!targetIsChart) {
      return {
        success: true,
        cdp_connected: true,
        target_id: target?.id,
        target_url: target?.url,
        target_title: target?.title,
        target_is_chart: false,
        chart_symbol: 'unknown',
        chart_resolution: 'unknown',
        chart_type: null,
        api_available: false,
      };
    }

    const state = await runEvaluate(`
    (function() {
      var result = { url: window.location.href, title: document.title };
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        result.symbol = chart.symbol();
        result.resolution = chart.resolution();
        result.chartType = chart.chartType();
        result.apiAvailable = true;
      } catch(e) {
        result.symbol = 'unknown';
        result.resolution = 'unknown';
        result.chartType = null;
        result.apiAvailable = false;
        result.apiError = e.message;
      }
      return result;
    })()
  `);

    return {
      success: true,
      cdp_connected: true,
      target_id: target.id,
      target_url: target.url,
      target_title: target.title,
      target_is_chart: true,
      chart_symbol: state?.symbol || 'unknown',
      chart_resolution: state?.resolution || 'unknown',
      chart_type: state?.chartType ?? null,
      api_available: state?.apiAvailable ?? false,
    };
  } catch (err) {
    return {
      success: false,
      error: classifyConnectionError(err),
      message: err?.message || String(err),
      cdp_connected: err?.code === 'renderer_unresponsive',
    };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function chartRoundTrip(timeoutMs) {
  // A same-symbol `setSymbol` + `symbol()` compare proves nothing: an ignored
  // (no-op) or hung `setSymbol` leaves `symbol()` unchanged, so it would read as
  // "ready". Readiness is therefore evidence the chart is *processing work*:
  //   1. no loading screen / symbol resolution in flight,
  //   2. the widget's own `dataReady` and `whenChartReady` callbacks FIRE,
  //   3. `setSymbol(same, cb)` — the callback form — FIRES (a no-op never calls it),
  //   4. the main series has bars.
  // Everything must complete inside the page within `budgetMs`; a hung renderer
  // never resolves the promise and trips the CDP deadline (`renderer_unresponsive`).
  const budgetMs = Math.max(500, Math.min(Number(timeoutMs) || 5000, 10000) - 200);
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var symbol = chart && typeof chart.symbol === 'function' ? chart.symbol() : '';
      var pending = { dataReady: true, whenChartReady: true, setSymbolCallback: true, bars: true };
      var result = { ready: false, symbol: symbol || '', pending: [] };
      if (!symbol || typeof chart.setSymbol !== 'function') {
        result.pending = ['no_symbol'];
        return result;
      }
      function busy() {
        try { if (typeof chart.loadingScreenActive === 'function' && chart.loadingScreenActive()) return 'loading_screen'; } catch (e) {}
        try { if (typeof chart.symbolResolvingActive === 'function' && chart.symbolResolvingActive()) return 'symbol_resolving'; } catch (e) {}
        return null;
      }
      function barsPresent() {
        try {
          var bars = ${KNOWN_PATHS.mainSeriesBars};
          return !!bars && typeof bars.size === 'function' && bars.size() > 0;
        } catch (e) { return false; }
      }
      return new Promise(function(resolve) {
        var settled = false;
        function check() {
          if (settled) return;
          if (!pending.dataReady && !pending.whenChartReady && !pending.setSymbolCallback && barsPresent() && !busy()) {
            pending.bars = false;
            settled = true;
            resolve({ ready: true, symbol: chart.symbol() || symbol, pending: [] });
          }
        }
        try { chart.dataReady(function() { pending.dataReady = false; check(); }); } catch (e) { pending.dataReady = 'error:' + e.message; }
        try { chart.whenChartReady(function() { pending.whenChartReady = false; check(); }); } catch (e) { pending.whenChartReady = 'error:' + e.message; }
        try { chart.setSymbol(symbol, function() { pending.setSymbolCallback = false; check(); }); } catch (e) { pending.setSymbolCallback = 'error:' + e.message; }
        var poll = setInterval(function() { if (settled) { clearInterval(poll); return; } check(); }, 100);
        setTimeout(function() {
          if (settled) return;
          settled = true;
          clearInterval(poll);
          var open = [];
          for (var k in pending) { if (pending[k]) open.push(k + (typeof pending[k] === 'string' ? '(' + pending[k] + ')' : '')); }
          var b = busy(); if (b) open.push(b);
          resolve({ ready: false, symbol: chart.symbol() || symbol, pending: open });
        }, ${budgetMs});
      });
    })()
  `, { awaitPromise: true, timeoutMs });
}

async function hasBars(timeoutMs) {
  try {
    const result = await data.getOhlcv({ count: 1, summary: false, timeoutMs });
    const bars = result?.bars || result?.data?.bars || [];
    return Array.isArray(bars) && bars.length > 0;
  } catch {
    return false;
  }
}

function hasChartTarget(status) {
  if (typeof status?.target_is_chart === 'boolean') return status.target_is_chart;
  if (status?.target_url) return /tradingview\.com\/chart/i.test(status.target_url);
  return true;
}

function mainProcessPid() {
  try {
    const name = process.platform === 'win32' ? 'TradingView.exe' : 'TradingView';
    const cmd = process.platform === 'win32'
      ? `tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH`
      : `pgrep -x ${name}`;
    const output = execSync(cmd, { timeout: 3000 }).toString().trim();
    if (process.platform === 'win32') {
      const match = output.match(/"TradingView\.exe","(\d+)"/i);
      return match ? Number(match[1]) : null;
    }
    const pid = Number(output.split('\n')[0]);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/**
 * GET /json/version with a hard deadline. A port that accepts the TCP connection
 * but never answers (Electron mid-shutdown, stalled network service) must not
 * hang the launcher before the readiness deadline even starts.
 */
export async function probeCdpVersion(cdpPort, timeoutMs = Number(process.env.TV_CDP_PROBE_TIMEOUT_MS) > 0
  ? Number(process.env.TV_CDP_PROBE_TIMEOUT_MS) : 3000) {
  const http = await import('http');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const req = http.get(`http://localhost:${cdpPort}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => finish(data));
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => { req.destroy(new Error('cdp_probe_timeout')); finish(null); }, timeoutMs);
    req.on('error', () => finish(null));
  });
}

/** Ensure a responsive chart renderer, relaunching TradingView only when required. */
export async function ensure({ timeout = 30, no_kill = false, _deps } = {}) {
  const startedAt = (_deps?.now || Date.now)();
  const timeoutMs = Math.max(1, Number(timeout) || 30) * 1000;
  const deadline = startedAt + timeoutMs;
  const check = _deps?.healthCheck || healthCheck;
  const doLaunch = _deps?.launch || launch;
  const wait = _deps?.sleep || sleep;
  const now = _deps?.now || Date.now;
  const getPid = _deps?.getPid || mainProcessPid;
  const probeChart = _deps?.chartRoundTrip || chartRoundTrip;
  const resetConnection = _deps?.disconnect || disconnect;

  // A quick `Runtime.evaluate` answering is not proof the chart can do work: a
  // partially stalled renderer (the 2026-09-17 10:20 shape) still answers the
  // health probe while `setSymbol` never takes. "Healthy" therefore requires the
  // same chart write/read round-trip the post-launch gate uses.
  let partialStall = null;
  const chartWorks = async () => {
    const remainingMs = Math.max(1, deadline - now());
    try {
      const probe = await probeChart(Math.min(remainingMs, getCdpTimeoutMs()));
      if (probe?.ready && probe.symbol) return true;
      partialStall = 'renderer_unresponsive';
    } catch (err) {
      partialStall = err?.code === 'mcp_disconnected' ? 'mcp_disconnected' : 'renderer_unresponsive';
    }
    return false;
  };

  let status = await check();
  if (status.success && status.api_available && hasChartTarget(status) && await chartWorks()) {
    return { action: 'none', reason: 'healthy', pid: await getPid(), elapsed_ms: now() - startedAt };
  }

  let reason = partialStall || status.error || 'api_unavailable';
  if (!partialStall && status.success && !status.api_available) {
    while (now() < deadline) {
      await resetConnection();
      await wait(Math.min(500, Math.max(1, deadline - now())));
      status = await check();
      if (status.success && status.api_available && hasChartTarget(status)) {
        if (await chartWorks()) {
          return { action: 'none', reason: 'healthy', pid: await getPid(), elapsed_ms: now() - startedAt };
        }
        reason = partialStall;
        break;
      }
      if (!status.success) {
        reason = status.error || 'mcp_disconnected';
        break;
      }
    }
  }

  await resetConnection();
  const launched = await doLaunch({ kill_existing: !no_kill });
  const readyDeadline = now() + timeoutMs;
  let lastStatus = status;
  let stableSymbol = null;
  while (now() < readyDeadline) {
    lastStatus = await check();
    const chartTargetReady = hasChartTarget(lastStatus);
    if (lastStatus.success && lastStatus.api_available && chartTargetReady) {
      const remainingMs = readyDeadline - now();
      if (remainingMs <= 0) break;
      try {
        const probe = await probeChart(remainingMs);
        if (probe?.ready && probe.symbol) {
          if (stableSymbol === probe.symbol) {
            // Symbol round-trips prove the widget accepts commands; the data feed
            // can still be empty for 10-30s after a cold launch. Readiness means
            // the active series has bars, otherwise the first read after ensure fails.
            const barsReady = await (_deps?.hasBars || hasBars)(Math.max(1, readyDeadline - now()));
            if (!barsReady) {
              await wait(Math.min(1000, Math.max(1, readyDeadline - now())));
              continue;
            }
            return {
              action: 'relaunched',
              reason,
              pid: launched?.pid ?? await getPid(),
              elapsed_ms: now() - startedAt,
            };
          }
          stableSymbol = probe.symbol;
          await wait(Math.min(1000, Math.max(1, readyDeadline - now())));
          continue;
        }
      } catch {
        // The widget can expose its API before it accepts chart operations.
      }
    } else if (lastStatus.success && (!lastStatus.api_available || !chartTargetReady)) {
      // Do not retain a live splash renderer or a chart renderer whose API has
      // not initialized; the next check must resolve the target list again.
      await resetConnection();
    }
    stableSymbol = null;
    await wait(Math.min(500, Math.max(1, readyDeadline - now())));
  }

  const err = new Error(`TradingView chart API did not stabilise within ${timeoutMs}ms`);
  err.code = 'api_unavailable';
  err.action = 'relaunched';
  err.reason = reason;
  err.pid = launched?.pid ?? null;
  err.elapsed_ms = now() - startedAt;
  throw err;
}

export async function discover() {
  const paths = await evaluate(`
    (function() {
      var results = {};
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var methods = [];
        for (var k in chart) { if (typeof chart[k] === 'function') methods.push(k); }
        results.chartApi = { available: true, path: 'window.TradingViewApi._activeChartWidgetWV.value()', methodCount: methods.length, methods: methods.slice(0, 50) };
      } catch(e) { results.chartApi = { available: false, error: e.message }; }
      try {
        var col = window.TradingViewApi._chartWidgetCollection;
        var colMethods = [];
        for (var k in col) { if (typeof col[k] === 'function') colMethods.push(k); }
        results.chartWidgetCollection = { available: !!col, path: 'window.TradingViewApi._chartWidgetCollection', methodCount: colMethods.length, methods: colMethods.slice(0, 30) };
      } catch(e) { results.chartWidgetCollection = { available: false, error: e.message }; }
      try {
        var ws = window.ChartApiInstance;
        var wsMethods = [];
        for (var k in ws) { if (typeof ws[k] === 'function') wsMethods.push(k); }
        results.chartApiInstance = { available: !!ws, path: 'window.ChartApiInstance', methodCount: wsMethods.length, methods: wsMethods.slice(0, 30) };
      } catch(e) { results.chartApiInstance = { available: false, error: e.message }; }
      try {
        var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
        var bwbMethods = [];
        if (bwb) { for (var k in bwb) { if (typeof bwb[k] === 'function') bwbMethods.push(k); } }
        results.bottomWidgetBar = { available: !!bwb, path: 'window.TradingView.bottomWidgetBar', methodCount: bwbMethods.length, methods: bwbMethods.slice(0, 20) };
      } catch(e) { results.bottomWidgetBar = { available: false, error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        results.replayApi = { available: !!replay, path: 'window.TradingViewApi._replayApi' };
      } catch(e) { results.replayApi = { available: false, error: e.message }; }
      try {
        var alerts = window.TradingViewApi._alertService;
        results.alertService = { available: !!alerts, path: 'window.TradingViewApi._alertService' };
      } catch(e) { results.alertService = { available: false, error: e.message }; }
      return results;
    })()
  `);

  const available = Object.values(paths).filter(v => v.available).length;
  const total = Object.keys(paths).length;

  return { success: true, apis_available: available, apis_total: total, apis: paths };
}

export async function uiState() {
  const state = await evaluate(`
    (function() {
      var ui = {};
      var bottom = document.querySelector('[class*="layout__area--bottom"]');
      ui.bottom_panel = { open: !!(bottom && bottom.offsetHeight > 50), height: bottom ? bottom.offsetHeight : 0 };
      var right = document.querySelector('[class*="layout__area--right"]');
      ui.right_panel = { open: !!(right && right.offsetWidth > 50), width: right ? right.offsetWidth : 0 };
      var monacoEl = document.querySelector('.monaco-editor.pine-editor-monaco');
      ui.pine_editor = { open: !!monacoEl, width: monacoEl ? monacoEl.offsetWidth : 0, height: monacoEl ? monacoEl.offsetHeight : 0 };
      var stratPanel = document.querySelector('[data-name="backtesting"]') || document.querySelector('[class*="strategyReport"]');
      ui.strategy_tester = { open: !!(stratPanel && stratPanel.offsetParent) };
      var widgetbar = document.querySelector('[data-name="widgetbar-wrap"]');
      ui.widgetbar = { open: !!(widgetbar && widgetbar.offsetWidth > 50) };
      ui.buttons = {};
      var btns = document.querySelectorAll('button');
      var seen = {};
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null || b.offsetWidth < 15) continue;
        var text = b.textContent.trim();
        var aria = b.getAttribute('aria-label') || '';
        var dn = b.getAttribute('data-name') || '';
        var label = text || aria || dn;
        if (!label || label.length > 60) continue;
        var key = label.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 40);
        if (seen[key]) continue;
        seen[key] = true;
        var rect = b.getBoundingClientRect();
        var region = 'other';
        if (rect.y < 50) region = 'top_bar';
        else if (rect.y < 90 && rect.x < 650) region = 'toolbar';
        else if (rect.x < 45) region = 'left_sidebar';
        else if (rect.x > 650 && rect.y < 100) region = 'pine_header';
        else if (rect.y > 750) region = 'bottom_bar';
        if (!ui.buttons[region]) ui.buttons[region] = [];
        ui.buttons[region].push({ label: label.substring(0, 40), disabled: b.disabled, x: Math.round(rect.x), y: Math.round(rect.y) });
      }
      ui.key_buttons = {};
      var keyLabels = {
        'add_to_chart': /add to chart/i, 'save_and_add': /save and add/i,
        'update_on_chart': /update on chart/i, 'save': /^Save(Save)?$/,
        'saved': /^Saved/, 'publish_script': /publish script/i,
        'compile_errors': /error/i, 'unsaved_version': /unsaved version/i,
      };
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetParent === null) continue;
        var text = b.textContent.trim();
        for (var k in keyLabels) {
          if (keyLabels[k].test(text)) {
            ui.key_buttons[k] = { text: text.substring(0, 40), disabled: b.disabled, visible: b.offsetWidth > 0 };
          }
        }
      }
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        ui.chart = { symbol: chart.symbol(), resolution: chart.resolution(), chartType: chart.chartType(), study_count: chart.getAllStudies().length };
      } catch(e) { ui.chart = { error: e.message }; }
      try {
        var replay = window.TradingViewApi._replayApi;
        function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
        ui.replay = { available: unwrap(replay.isReplayAvailable()), started: unwrap(replay.isReplayStarted()) };
      } catch(e) { ui.replay = { error: e.message }; }
      return ui;
    })()
  `);

  return { success: true, ...state };
}

export async function launch({ port, kill_existing } = {}) {
  const cdpPort = port || 9222;
  const killFirst = kill_existing !== false;
  const platform = process.platform;

  const pathMap = {
    darwin: [
      '/Applications/TradingView.app/Contents/MacOS/TradingView',
      `${process.env.HOME}/Applications/TradingView.app/Contents/MacOS/TradingView`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
      `${process.env.PROGRAMFILES}\\TradingView\\TradingView.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\TradingView\\TradingView.exe`,
    ],
    linux: [
      '/opt/TradingView/tradingview',
      '/opt/TradingView/TradingView',
      `${process.env.HOME}/.local/share/TradingView/TradingView`,
      '/usr/bin/tradingview',
      '/snap/tradingview/current/tradingview',
    ],
  };

  let tvPath = null;
  const candidates = pathMap[platform] || pathMap.linux;
  for (const p of candidates) {
    if (p && existsSync(p)) { tvPath = p; break; }
  }

  if (!tvPath) {
    try {
      const cmd = platform === 'win32' ? 'where TradingView.exe' : 'which tradingview';
      tvPath = execSync(cmd, { timeout: 3000 }).toString().trim().split('\n')[0];
      if (tvPath && !existsSync(tvPath)) tvPath = null;
    } catch { /* ignore */ }
  }

  if (!tvPath && platform === 'darwin') {
    try {
      const found = execSync('mdfind "kMDItemFSName == TradingView.app" | head -1', { timeout: 5000 }).toString().trim();
      if (found) {
        const candidate = `${found}/Contents/MacOS/TradingView`;
        if (existsSync(candidate)) tvPath = candidate;
      }
    } catch { /* ignore */ }
  }

  if (!tvPath) {
    throw new Error(`TradingView not found on ${platform}. Searched: ${candidates.join(', ')}. Launch manually with: /path/to/TradingView --remote-debugging-port=${cdpPort}`);
  }

  if (killFirst) {
    try {
      if (platform === 'win32') execSync('taskkill /F /IM TradingView.exe', { timeout: 5000 });
      // Match the main executable name only. A broad `pkill -f TradingView` also
      // signals the ShipIt updater and can interrupt an in-progress installation.
      else if (platform === 'darwin') execSync('pkill -x TradingView', { timeout: 5000 });
      else {
        try { execSync('pkill -x tradingview', { timeout: 5000 }); }
        catch { execSync('pkill -x TradingView', { timeout: 5000 }); }
      }
      await new Promise(r => setTimeout(r, 1500));
    } catch { /* may not be running */ }
  }

  const child = spawn(tvPath, [`--remote-debugging-port=${cdpPort}`], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const ready = await probeCdpVersion(cdpPort);
      if (ready) {
        const info = JSON.parse(ready);
        return {
          success: true, platform, binary: tvPath, pid: child.pid,
          cdp_port: cdpPort, cdp_url: `http://localhost:${cdpPort}`,
          browser: info.Browser, user_agent: info['User-Agent'],
        };
      }
    } catch { /* retry */ }
  }

  return {
    success: true, platform, binary: tvPath, pid: child.pid, cdp_port: cdpPort, cdp_ready: false,
    warning: 'TradingView launched but CDP not responding yet. It may still be loading. Try tv_health_check in a few seconds.',
  };
}
