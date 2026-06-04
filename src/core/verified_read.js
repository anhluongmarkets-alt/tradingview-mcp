/**
 * Verified TradingView reads: set chart -> confirm active symbol -> read -> sanity-check -> restore.
 */
import * as chart from './chart.js';
import * as data from './data.js';

const DEFAULT_CONFIRM_ATTEMPTS = 10;
const DEFAULT_CONFIRM_DELAY_MS = 150;
const DEFAULT_READ_ATTEMPTS = 3;
const DEFAULT_READ_RETRY_DELAY_MS = 500;
const DEFAULT_PRICE_GUARD = '/Users/mb/Projects/STMS-AI-Trading-Desk/scripts/price-plausibility.mjs';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeSymbol(symbol) {
  return String(symbol || '')
    .split(':')
    .pop()
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
}

function symbolsMatch(actual, expected) {
  const left = normalizeSymbol(actual);
  const right = normalizeSymbol(expected);
  return Boolean(left && right && (left === right || left.endsWith(right) || right.endsWith(left)));
}

function errorCode(err, fallback) {
  const message = err?.message || String(err || '');
  if (/CDP|connection|ECONNREFUSED|not running|disconnected/i.test(message)) return 'mcp_disconnected';
  return fallback;
}

async function loadMeaningfulPriceChecker(deps) {
  if (deps?.isMeaningfulPrice) return deps.isMeaningfulPrice;
  const modulePath = process.env.STMS_PRICE_PLAUSIBILITY_MODULE || DEFAULT_PRICE_GUARD;
  const mod = await import(modulePath);
  if (typeof mod.isMeaningfulPrice !== 'function') {
    throw new Error(`isMeaningfulPrice export missing from ${modulePath}`);
  }
  return mod.isMeaningfulPrice;
}

function getReadPrice(read, result) {
  if (read === 'quote') return Number(result?.last ?? result?.close);
  const bars = result?.bars || result?.data?.bars || [];
  const last = bars[bars.length - 1];
  return Number(last?.close);
}

async function readWithPlausibility({
  symbol,
  timeframe,
  read,
  count,
  priceKey,
  isMeaningfulPrice,
  confirmAttempts,
  confirmDelayMs,
  deps,
}) {
  let lastResult = null;
  let lastPrice = NaN;

  for (let attempt = 1; attempt <= DEFAULT_READ_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const setResult = await (deps?.setSymbol || chart.setSymbol)({ symbol });
      if (setResult?.success === false) throw new Error(setResult.error || 'symbol set returned success:false');
      if (timeframe) {
        const tfResult = await (deps?.setTimeframe || chart.setTimeframe)({ timeframe });
        if (tfResult?.success === false) throw new Error(tfResult.error || 'timeframe set returned success:false');
      }
      const confirmed = await confirmSymbol({
        symbol,
        attempts: confirmAttempts,
        delayMs: confirmDelayMs,
        deps,
      });
      if (!confirmed.matched) {
        throw new Error(`active symbol ${confirmed.state?.symbol || 'unknown'} did not match ${symbol}`);
      }
      await sleep(DEFAULT_READ_RETRY_DELAY_MS);
    }

    const result = read === 'quote'
      ? await (deps?.getQuote || data.getQuote)({})
      : await (deps?.getOhlcv || data.getOhlcv)({ count: Number(count), summary: false });
    const price = getReadPrice(read, result);
    lastResult = result;
    lastPrice = price;

    if (Number.isFinite(price) && isMeaningfulPrice(priceKey, price)) {
      return { result, price, attempts: attempt };
    }

    if (attempt < DEFAULT_READ_ATTEMPTS) {
      await sleep(DEFAULT_READ_RETRY_DELAY_MS);
    }
  }

  return { result: lastResult, price: lastPrice, attempts: DEFAULT_READ_ATTEMPTS };
}

async function restoreChart(original, deps) {
  if (!original?.symbol) return { restored: false, restore_error: 'original_state_missing' };
  try {
    await (deps?.setSymbol || chart.setSymbol)({ symbol: original.symbol });
    if (original.resolution) {
      await (deps?.setTimeframe || chart.setTimeframe)({ timeframe: original.resolution });
    }
    return {
      restored: true,
      restored_to: { symbol: original.symbol, timeframe: original.resolution },
    };
  } catch (err) {
    return {
      restored: false,
      restored_to: { symbol: original.symbol, timeframe: original.resolution },
      restore_error: err.message || String(err),
    };
  }
}

async function confirmSymbol({ symbol, attempts, delayMs, deps }) {
  let lastState = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    lastState = await (deps?.getState || chart.getState)();
    if (symbolsMatch(lastState?.symbol, symbol)) {
      return { matched: true, state: lastState, attempts: attempt };
    }
    await sleep(delayMs);
  }
  return { matched: false, state: lastState, attempts };
}

export async function verifiedRead({
  symbol,
  timeframe,
  read,
  count,
  instrument_key,
  restore = true,
  confirm_attempts = DEFAULT_CONFIRM_ATTEMPTS,
  confirm_delay_ms = DEFAULT_CONFIRM_DELAY_MS,
  _deps,
} = {}) {
  if (!symbol) return { success: false, error: 'set_failed', message: 'symbol is required', restored: false };
  if (!['quote', 'ohlcv'].includes(read)) {
    return { success: false, error: 'read_failed', message: 'read must be quote or ohlcv', symbol, restored: false };
  }
  if (read === 'ohlcv' && !Number.isFinite(Number(count))) {
    return { success: false, error: 'read_failed', message: 'count is required for ohlcv reads', symbol, restored: false };
  }

  let original = null;
  let confirmed = null;
  let result = null;
  let response = null;

  try {
    try {
      original = await (_deps?.getState || chart.getState)();
    } catch (err) {
      response = { success: false, error: errorCode(err, 'mcp_disconnected'), message: err.message || String(err), symbol, restored: false };
      return response;
    }

    try {
      const setResult = await (_deps?.setSymbol || chart.setSymbol)({ symbol });
      if (setResult?.success === false) throw new Error(setResult.error || 'symbol set returned success:false');
      if (timeframe) {
        const tfResult = await (_deps?.setTimeframe || chart.setTimeframe)({ timeframe });
        if (tfResult?.success === false) throw new Error(tfResult.error || 'timeframe set returned success:false');
      }
    } catch (err) {
      response = { success: false, error: 'set_failed', message: err.message || String(err), symbol, restored: false };
      return response;
    }

    confirmed = await confirmSymbol({
      symbol,
      attempts: Number(confirm_attempts) || DEFAULT_CONFIRM_ATTEMPTS,
      delayMs: Number(confirm_delay_ms) || DEFAULT_CONFIRM_DELAY_MS,
      deps: _deps,
    });
    if (!confirmed.matched) {
      response = {
        success: false,
        error: 'symbol_confirm_timeout',
        message: `active symbol ${confirmed.state?.symbol || 'unknown'} did not match ${symbol}`,
        symbol,
        confirmed_symbol: confirmed.state?.symbol || '',
        confirm_attempts: confirmed.attempts,
        restored: false,
      };
      return response;
    }

    let readAttempts = 0;
    const isMeaningfulPrice = await loadMeaningfulPriceChecker(_deps);
    const priceKey = instrument_key || symbol;
    try {
      const readResult = await readWithPlausibility({
        symbol,
        timeframe,
        read,
        count,
        priceKey,
        isMeaningfulPrice,
        confirmAttempts: Number(confirm_attempts) || DEFAULT_CONFIRM_ATTEMPTS,
        confirmDelayMs: Number(confirm_delay_ms) || DEFAULT_CONFIRM_DELAY_MS,
        deps: _deps,
      });
      result = readResult.result;
      readAttempts = readResult.attempts;
    } catch (err) {
      response = {
        success: false,
        error: 'read_failed',
        message: err.message || String(err),
        symbol,
        confirmed_symbol: confirmed.state?.symbol || '',
        confirm_attempts: confirmed.attempts,
        restored: false,
      };
      return response;
    }

    const price = getReadPrice(read, result);
    if (!Number.isFinite(price) || !isMeaningfulPrice(priceKey, price)) {
      response = {
        success: false,
        error: 'magnitude_mismatch',
        message: `${priceKey} price ${price} failed plausibility check`,
        symbol,
        confirmed_symbol: confirmed.state?.symbol || '',
        confirm_attempts: confirmed.attempts,
        read_attempts: readAttempts,
        restored: false,
      };
      return response;
    }

    response = {
      success: true,
      symbol,
      confirmed_symbol: confirmed.state?.symbol || symbol,
      timeframe: timeframe || confirmed.state?.resolution || '',
      read,
      data: read === 'quote' ? result : { bars: result.bars || [] },
      confirm_attempts: confirmed.attempts,
      read_attempts: readAttempts,
      restored: false,
    };
    return response;
  } finally {
    if (restore && original?.symbol) {
      const restoreResult = await restoreChart(original, _deps);
      if (response) {
        Object.assign(response, restoreResult);
      }
    }
  }
}
