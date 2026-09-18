import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;
const DEFAULT_CDP_TIMEOUT_MS = 15000;

export class ConnectionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

export function getCdpTimeoutMs() {
  const configured = Number(process.env.TV_CDP_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_CDP_TIMEOUT_MS;
}

function closeClient(candidate) {
  if (!candidate || typeof candidate.close !== 'function') return;
  try {
    Promise.resolve(candidate.close()).catch(() => {});
  } catch { /* already closed */ }
  if (client === candidate) {
    client = null;
    targetInfo = null;
  }
}

/** Run one CDP operation with a hard deadline and close its socket on timeout. */
export async function cdpCall(candidate, operationName, operation, timeoutMs = getCdpTimeoutMs()) {
  let timer;
  const pending = Promise.resolve().then(operation);
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      closeClient(candidate);
      reject(new ConnectionError(
        'renderer_unresponsive',
        `${operationName} timed out after ${timeoutMs}ms`,
      ));
    }, timeoutMs);
  });

  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
    // Prevent a late rejection from an operation which lost the timeout race.
    pending.catch(() => {});
  }
}

function disconnected(message, cause) {
  return new ConnectionError('mcp_disconnected', message, cause ? { cause } : {});
}

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export function isChartTarget(target) {
  return Boolean(target?.type === 'page' && /tradingview\.com\/chart/i.test(target.url || ''));
}

export async function getClient(_deps = {}) {
  if (client) {
    if (!isChartTarget(targetInfo)) {
      // Electron's splash renderer remains CDP-responsive after the real chart
      // target appears. Never let that liveness keep a non-chart target cached.
      closeClient(client);
      return connect(_deps);
    }
    try {
      // Quick liveness check
      await cdpCall(client, 'Runtime.evaluate', () => client.Runtime.evaluate({ expression: '1', returnByValue: true }));
      return client;
    } catch (err) {
      closeClient(client);
      client = null;
      targetInfo = null;
      if (err?.code === 'renderer_unresponsive') throw err;
    }
  }
  return connect(_deps);
}

export async function connect(_deps = {}) {
  const cdpFactory = _deps.cdp || CDP;
  const wait = _deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget(_deps);
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      let connectedClient;
      const connectPromise = cdpFactory({ host: CDP_HOST, port: CDP_PORT, target: target.id });
      // If connection establishment itself times out, close a socket that resolves late.
      connectPromise.then(value => {
        connectedClient = value;
      }).catch(() => {});
      try {
        client = await cdpCall(null, 'CDP target connect', () => connectPromise);
      } catch (err) {
        connectPromise.then(closeClient).catch(() => {});
        closeClient(connectedClient);
        throw err;
      }

      // Enable required domains
      await cdpCall(client, 'Runtime.enable', () => client.Runtime.enable());
      await cdpCall(client, 'Page.enable', () => client.Page.enable());
      await cdpCall(client, 'DOM.enable', () => client.DOM.enable());

      return client;
    } catch (err) {
      lastError = err;
      closeClient(client);
      targetInfo = null;
      if (err?.code === 'renderer_unresponsive') throw err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      if (attempt < MAX_RETRIES - 1) await wait(delay);
    }
  }
  throw disconnected(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`, lastError);
}

export async function findChartTarget(_deps = {}) {
  const fetchImpl = _deps.fetch || fetch;
  let resp;
  try {
    resp = await cdpCall(null, 'CDP target listing', () => fetchImpl(`http://${CDP_HOST}:${CDP_PORT}/json/list`));
  } catch (err) {
    if (err?.code === 'renderer_unresponsive') throw err;
    throw disconnected(`CDP target listing failed: ${err?.message || err}`, err);
  }
  if (!resp.ok) throw disconnected(`CDP target listing failed: HTTP ${resp.status}`);
  const targets = await cdpCall(null, 'CDP target listing response', () => resp.json());
  // Splash/file:// renderers are live CDP pages but cannot serve chart APIs.
  return targets.find(isChartTarget) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const { timeoutMs, ...evaluateOpts } = opts;
  const result = await cdpCall(c, 'Runtime.evaluate', () => c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: evaluateOpts.awaitPromise ?? false,
    ...evaluateOpts,
  }), timeoutMs ?? getCdpTimeoutMs());
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
