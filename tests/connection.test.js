import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cdpCall,
  disconnect,
  getCdpTimeoutMs,
  getClient,
  getTargetInfo,
} from '../src/connection.js';

describe('CDP timeout', () => {
  it('accepts TV_CDP_TIMEOUT_MS as the timeout override', () => {
    const previous = process.env.TV_CDP_TIMEOUT_MS;
    process.env.TV_CDP_TIMEOUT_MS = '321';
    try {
      assert.equal(getCdpTimeoutMs(), 321);
    } finally {
      if (previous === undefined) delete process.env.TV_CDP_TIMEOUT_MS;
      else process.env.TV_CDP_TIMEOUT_MS = previous;
    }
  });

  it('closes a stalled client and throws renderer_unresponsive', async () => {
    let closed = 0;
    const client = {
      Runtime: { evaluate: () => new Promise(() => {}) },
      close: async () => { closed += 1; },
    };

    await assert.rejects(
      cdpCall(client, 'Runtime.evaluate', () => client.Runtime.evaluate({ expression: '1' }), 20),
      err => err.code === 'renderer_unresponsive' && /Runtime\.evaluate timed out/.test(err.message),
    );
    assert.equal(closed, 1);
  });

  it('ignores a splash target and connects when the chart target appears', async () => {
    await disconnect();
    const splash = { id: 'splash', type: 'page', url: 'file:///Applications/TradingView.app/Contents/Resources/splash.html' };
    const chart = { id: 'chart', type: 'page', url: 'https://www.tradingview.com/chart/abc123/' };
    const targetLists = [[splash], [splash, chart]];
    const connectedTargets = [];
    const sleeps = [];
    const fakeClient = {
      Runtime: {
        enable: async () => {},
        evaluate: async () => ({ result: { value: 1 } }),
      },
      Page: { enable: async () => {} },
      DOM: { enable: async () => {} },
      close: async () => {},
    };

    try {
      await getClient({
        fetch: async () => ({
          ok: true,
          json: async () => targetLists.shift() || [chart],
        }),
        cdp: async ({ target }) => {
          connectedTargets.push(target);
          return fakeClient;
        },
        sleep: async ms => { sleeps.push(ms); },
      });

      assert.equal((await getTargetInfo()).id, 'chart');
      assert.deepEqual(connectedTargets, ['chart']);
      assert.equal(sleeps.length, 1);
    } finally {
      await disconnect();
    }
  });
});
