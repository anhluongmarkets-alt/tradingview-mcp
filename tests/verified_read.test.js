import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedRead } from '../src/core/verified_read.js';

function deps({
  states,
  quote,
  ohlcv,
  ohlcvQueue,
  quoteError,
  meaningful = true,
} = {}) {
  const calls = [];
  const stateQueue = [...states];
  const ohlcvResults = [...(ohlcvQueue || [])];
  return {
    calls,
    getState: async () => {
      calls.push(['getState']);
      return stateQueue.shift() || stateQueue[stateQueue.length - 1] || { symbol: 'OANDA:EURGBP', resolution: '240' };
    },
    setSymbol: async ({ symbol }) => {
      calls.push(['setSymbol', symbol]);
      return { success: true, symbol };
    },
    setTimeframe: async ({ timeframe }) => {
      calls.push(['setTimeframe', timeframe]);
      return { success: true, timeframe };
    },
    sleep: async (ms) => {
      calls.push(['sleep', ms]);
    },
    getQuote: async () => {
      calls.push(['getQuote']);
      if (quoteError) throw quoteError instanceof Error ? quoteError : new Error(quoteError);
      return quote || { success: true, symbol: 'OANDA:XAUUSD', last: 4485 };
    },
    getOhlcv: async ({ count }) => {
      calls.push(['getOhlcv', count]);
      if (ohlcvResults.length > 0) return ohlcvResults.shift();
      return ohlcv || { success: true, bars: [{ time: 1, open: 4480, high: 4490, low: 4470, close: 4485 }] };
    },
    isMeaningfulPrice: (...args) => typeof meaningful === 'function' ? meaningful(...args) : meaningful,
  };
}

describe('verifiedRead', () => {
  it('happy path confirms, reads OHLCV, and restores original chart', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:EURGBP', resolution: '240' },
        { symbol: 'OANDA:XAUUSD', resolution: 'D' },
      ],
    });

    const result = await verifiedRead({
      symbol: 'OANDA:XAUUSD',
      timeframe: 'D',
      read: 'ohlcv',
      count: 180,
      instrument_key: 'XAU/USD',
      _deps: fake,
    });

    assert.equal(result.success, true);
    assert.equal(result.confirmed_symbol, 'OANDA:XAUUSD');
    assert.equal(result.data.bars.length, 1);
    assert.equal(result.restored, true);
    assert.deepEqual(result.restored_to, { symbol: 'OANDA:EURGBP', timeframe: '240' });
    assert.deepEqual(fake.calls.filter(c => c[0] === 'setSymbol').map(c => c[1]), ['OANDA:XAUUSD', 'OANDA:EURGBP']);
  });

  it('silent revert fails closed instead of returning active EURGBP data as BTC', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:EURGBP', resolution: '240' },
        { symbol: 'OANDA:EURGBP', resolution: '240' },
        { symbol: 'OANDA:EURGBP', resolution: '240' },
      ],
    });

    const result = await verifiedRead({
      symbol: 'BITSTAMP:BTCUSD',
      read: 'quote',
      confirm_attempts: 2,
      confirm_delay_ms: 1,
      _deps: fake,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'symbol_confirm_timeout');
    assert.equal(result.restored, true);
    assert.equal(fake.calls.some(c => c[0] === 'getQuote'), false);
  });

  it('magnitude trap fails when confirmed symbol returns implausible price', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:EURGBP', resolution: '240' },
        { symbol: 'OANDA:XAUUSD', resolution: '240' },
        { symbol: 'OANDA:XAUUSD', resolution: '240' },
        { symbol: 'OANDA:XAUUSD', resolution: '240' },
      ],
      quote: { success: true, symbol: 'OANDA:XAUUSD', last: 0.86 },
      meaningful: false,
    });

    const result = await verifiedRead({
      symbol: 'OANDA:XAUUSD',
      read: 'quote',
      instrument_key: 'XAU/USD',
      _deps: fake,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'magnitude_mismatch');
    assert.equal(result.restored, true);
  });

  it('retries OHLCV reads when chart bars lag behind confirmed symbol', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:AUDUSD', resolution: '240' },
        { symbol: 'OANDA:EURGBP', resolution: '240' },
      ],
      ohlcvQueue: [
        { success: true, bars: [{ time: 1, open: 0.713, high: 0.714, low: 0.712, close: 0.713 }] },
        { success: true, bars: [{ time: 2, open: 0.864, high: 0.865, low: 0.863, close: 0.8647 }] },
      ],
      meaningful: (_key, price) => price > 0.8 && price < 0.9,
    });

    const result = await verifiedRead({
      symbol: 'OANDA:EURGBP',
      timeframe: '240',
      read: 'ohlcv',
      count: 180,
      instrument_key: 'EUR/GBP',
      _deps: fake,
    });

    assert.equal(result.success, true);
    assert.equal(result.read_attempts, 2);
    assert.equal(result.data.bars.at(-1).close, 0.8647);
    assert.equal(fake.calls.filter(c => c[0] === 'getOhlcv').length, 2);
  });

  it('waits for a freshly launched chart whose data feed returns no bars yet', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:AUDJPY', resolution: '240' },
        { symbol: 'OANDA:EURUSD', resolution: '240' },
        { symbol: 'OANDA:EURUSD', resolution: '240' },
      ],
      ohlcvQueue: [
        { success: true, bars: [] },
        { success: true, bars: [] },
        { success: true, bars: [] },
        { success: true, bars: [] },
        { success: true, bars: [{ time: 5, open: 1.146, high: 1.147, low: 1.145, close: 1.1461 }] },
      ],
      meaningful: (_key, price) => price > 1 && price < 1.3,
    });
    fake.emptyReadDelayMs = 1;

    const result = await verifiedRead({
      symbol: 'OANDA:EURUSD',
      timeframe: '240',
      read: 'ohlcv',
      count: 180,
      instrument_key: 'EUR/USD',
      _deps: fake,
    });

    assert.equal(result.success, true);
    assert.equal(result.read_attempts, 5, 'empty reads extend the bounded retry budget past the default 3');
    assert.equal(result.data.bars.at(-1).close, 1.1461);
    assert.equal(fake.calls.filter(c => c[0] === 'setSymbol' && c[1] === 'OANDA:EURUSD').length, 1, 'symbol is not re-set while bars are merely loading');
  });

  it('still fails closed when the data feed never delivers bars', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:AUDJPY', resolution: '240' },
        { symbol: 'OANDA:EURUSD', resolution: '240' },
        { symbol: 'OANDA:EURUSD', resolution: '240' },
      ],
      ohlcvQueue: Array.from({ length: 12 }, () => ({ success: true, bars: [] })),
      meaningful: () => true,
    });
    fake.emptyReadDelayMs = 1;

    const result = await verifiedRead({
      symbol: 'OANDA:EURUSD',
      timeframe: '240',
      read: 'ohlcv',
      count: 180,
      instrument_key: 'EUR/USD',
      _deps: fake,
    });

    assert.equal(result.success, false);
    assert.equal(fake.calls.filter(c => c[0] === 'getOhlcv').length, 8, 'bounded at DEFAULT_EMPTY_READ_ATTEMPTS');
  });

  it('restore-on-error restores original chart state after read failure', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:EURGBP', resolution: '240' },
        { symbol: 'OANDA:XAUUSD', resolution: '240' },
      ],
      quoteError: 'Could not retrieve quote',
    });

    const result = await verifiedRead({
      symbol: 'OANDA:XAUUSD',
      read: 'quote',
      _deps: fake,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'read_failed');
    assert.equal(result.restored, true);
    assert.deepEqual(result.restored_to, { symbol: 'OANDA:EURGBP', timeframe: '240' });
  });

  it('classifies a stalled renderer separately and reports the failed read attempt', async () => {
    const stalled = new Error('Runtime.evaluate timed out after 15ms');
    stalled.code = 'renderer_unresponsive';
    const fake = deps({
      states: [
        { symbol: 'OANDA:EURGBP', resolution: '240' },
        { symbol: 'OANDA:XAUUSD', resolution: '240' },
      ],
      quoteError: stalled,
    });

    const result = await verifiedRead({
      symbol: 'OANDA:XAUUSD',
      read: 'quote',
      _deps: fake,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'renderer_unresponsive');
    assert.equal(result.confirm_attempts, 1);
    assert.equal(result.read_attempts, 1);
  });

  it('reissues a silently ignored symbol set and succeeds within the confirm budget', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:AUDJPY', resolution: '240' },
        { symbol: 'OANDA:AUDJPY', resolution: '240' },
        { symbol: 'OANDA:EURUSD', resolution: '240' },
      ],
      quote: { success: true, symbol: 'OANDA:EURUSD', last: 1.18 },
    });

    const result = await verifiedRead({
      symbol: 'OANDA:EURUSD',
      timeframe: '240',
      read: 'quote',
      confirm_attempts: 2,
      _deps: fake,
    });

    assert.equal(result.success, true);
    assert.equal(result.confirm_attempts, 2);
    assert.equal(fake.calls.filter(call => call[0] === 'setSymbol' && call[1] === 'OANDA:EURUSD').length, 2);
    assert.ok(fake.calls.some(call => call[0] === 'sleep' && call[1] === 1000));
  });

  it('fails with the same bounded mismatch shape when the symbol retry is ignored', async () => {
    const fake = deps({
      states: [
        { symbol: 'OANDA:AUDJPY', resolution: '240' },
        { symbol: 'OANDA:AUDJPY', resolution: '240' },
        { symbol: 'OANDA:AUDJPY', resolution: '240' },
      ],
    });

    const result = await verifiedRead({
      symbol: 'OANDA:EURUSD',
      timeframe: '240',
      read: 'quote',
      confirm_attempts: 2,
      _deps: fake,
    });

    assert.equal(result.success, false);
    assert.equal(result.error, 'symbol_confirm_timeout');
    assert.equal(result.message, 'active symbol OANDA:AUDJPY did not match OANDA:EURUSD');
    assert.equal(result.confirm_attempts, 2);
    assert.equal(fake.calls.some(call => call[0] === 'getQuote'), false);
  });
});
