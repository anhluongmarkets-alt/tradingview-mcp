import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedRead } from '../src/core/verified_read.js';

function deps({
  states,
  quote,
  ohlcv,
  quoteError,
  meaningful = true,
} = {}) {
  const calls = [];
  const stateQueue = [...states];
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
    getQuote: async () => {
      calls.push(['getQuote']);
      if (quoteError) throw new Error(quoteError);
      return quote || { success: true, symbol: 'OANDA:XAUUSD', last: 4485 };
    },
    getOhlcv: async ({ count }) => {
      calls.push(['getOhlcv', count]);
      return ohlcv || { success: true, bars: [{ time: 1, open: 4480, high: 4490, low: 4470, close: 4485 }] };
    },
    isMeaningfulPrice: () => meaningful,
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
});
