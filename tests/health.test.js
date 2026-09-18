import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ensure, healthCheck, probeCdpVersion } from '../src/core/health.js';
import net from 'node:net';

function fakeDeps(statuses, roundTrips = [{ ready: true, symbol: 'OANDA:AUDJPY' }]) {
  const queue = [...statuses];
  const probeQueue = [...roundTrips];
  const launches = [];
  const probes = [];
  const sleeps = [];
  let disconnects = 0;
  return {
    launches,
    probes,
    sleeps,
    healthCheck: async () => queue.shift() || statuses.at(-1),
    chartRoundTrip: async timeoutMs => {
      probes.push(timeoutMs);
      return probeQueue.shift() || roundTrips.at(-1);
    },
    launch: async options => {
      launches.push(options);
      return { pid: 4321 };
    },
    sleep: async ms => { sleeps.push(ms); },
    disconnect: async () => { disconnects += 1; },
    get disconnects() { return disconnects; },
    getPid: async () => 1234,
    hasBars: async () => true,
  };
}

describe('ensure', () => {
  it('relaunches when the CDP port is down', async () => {
    const fake = fakeDeps([
      { success: false, error: 'mcp_disconnected' },
      { success: true, api_available: true },
    ]);
    const result = await ensure({ timeout: 1, _deps: fake });
    assert.equal(result.action, 'relaunched');
    assert.equal(result.reason, 'mcp_disconnected');
    assert.equal(result.pid, 4321);
    assert.deepEqual(fake.launches, [{ kill_existing: true }]);
  });

  it('does nothing when the chart renderer is responsive', async () => {
    const fake = fakeDeps([{ success: true, api_available: true }]);
    const result = await ensure({ timeout: 1, _deps: fake });
    assert.deepEqual(result.action, 'none');
    assert.equal(result.reason, 'healthy');
    assert.equal(result.pid, 1234);
    assert.equal(fake.launches.length, 0);
  });

  it('probes the chart before calling a live renderer healthy', async () => {
    const fake = fakeDeps([{ success: true, api_available: true }]);
    const result = await ensure({ timeout: 1, _deps: fake });
    assert.equal(result.action, 'none');
    assert.equal(fake.probes.length, 1, 'healthy path must run the chart round-trip');
  });

  it('relaunches a partially stalled renderer whose health probe answers but the chart does not', async () => {
    const fake = fakeDeps(
      [{ success: true, api_available: true }, { success: true, api_available: true }],
      [{ ready: false, symbol: 'OANDA:AUDJPY' }, { ready: true, symbol: 'OANDA:AUDJPY' }, { ready: true, symbol: 'OANDA:AUDJPY' }],
    );
    const result = await ensure({ timeout: 1, _deps: fake });
    assert.equal(result.action, 'relaunched');
    assert.equal(result.reason, 'renderer_unresponsive');
    assert.deepEqual(fake.launches, [{ kill_existing: true }]);
  });

  it('relaunches when the chart round-trip times out on a live target', async () => {
    const fake = fakeDeps([{ success: true, api_available: true }, { success: true, api_available: true }]);
    let first = true;
    fake.chartRoundTrip = async () => {
      if (first) { first = false; const e = new Error('Runtime.evaluate timed out'); e.code = 'renderer_unresponsive'; throw e; }
      return { ready: true, symbol: 'OANDA:AUDJPY' };
    };
    const result = await ensure({ timeout: 1, _deps: fake });
    assert.equal(result.action, 'relaunched');
    assert.equal(result.reason, 'renderer_unresponsive');
  });

  it('relaunches when the renderer is unresponsive and passes no-kill through', async () => {
    const fake = fakeDeps([
      { success: false, error: 'renderer_unresponsive' },
      { success: true, api_available: true },
    ]);
    const result = await ensure({ timeout: 1, no_kill: true, _deps: fake });
    assert.equal(result.action, 'relaunched');
    assert.equal(result.reason, 'renderer_unresponsive');
    assert.deepEqual(fake.launches, [{ kill_existing: false }]);
  });

  it('waits for two stable chart write/read round-trips after relaunch', async () => {
    const fake = fakeDeps([
      { success: false, error: 'mcp_disconnected' },
      { success: true, api_available: true },
    ], [
      { ready: false, symbol: 'OANDA:AUDJPY' },
      { ready: true, symbol: 'OANDA:AUDJPY' },
      { ready: true, symbol: 'OANDA:AUDJPY' },
    ]);

    const result = await ensure({ timeout: 1, _deps: fake });

    assert.equal(result.action, 'relaunched');
    assert.equal(fake.probes.length, 3);
    assert.ok(fake.sleeps.some(ms => ms >= 900));
  });

  it('waits for the data feed to deliver bars before reporting relaunched', async () => {
    const fake = fakeDeps([
      { success: false, error: 'mcp_disconnected' },
      { success: true, api_available: true },
    ]);
    const barsQueue = [false, false, true];
    fake.hasBars = async () => barsQueue.shift() ?? true;
    const result = await ensure({ timeout: 5, _deps: fake });
    assert.equal(result.action, 'relaunched');
    assert.equal(barsQueue.length, 0, 'ensure kept polling until bars were present');
  });

  it('fails typed api_unavailable when the chart never stabilises before timeout', async () => {
    let clock = 0;
    const fake = fakeDeps([
      { success: false, error: 'mcp_disconnected' },
      { success: true, api_available: true },
    ], [{ ready: false, symbol: 'OANDA:AUDJPY' }]);
    fake.now = () => clock;
    fake.sleep = async ms => {
      fake.sleeps.push(ms);
      clock += ms;
    };

    await assert.rejects(
      ensure({ timeout: 1, _deps: fake }),
      err => err.code === 'api_unavailable' && err.action === 'relaunched',
    );
  });

  it('disconnects a splash target and waits for the chart target after relaunch', async () => {
    const fake = fakeDeps([
      { success: false, error: 'mcp_disconnected' },
      {
        success: true,
        api_available: false,
        target_is_chart: false,
        target_url: 'file:///Applications/TradingView.app/Contents/Resources/splash.html',
      },
      {
        success: true,
        api_available: true,
        target_is_chart: true,
        target_url: 'https://www.tradingview.com/chart/abc123/',
      },
    ]);

    const result = await ensure({ timeout: 1, _deps: fake });

    assert.equal(result.action, 'relaunched');
    assert.ok(fake.disconnects >= 2);
    assert.equal(fake.probes.length, 2);
  });
});

describe('healthCheck target classification', () => {
  it('reports a non-chart page target as unavailable', async () => {
    let evaluated = false;
    const result = await healthCheck({
      _deps: {
        getClient: async () => ({}),
        getTargetInfo: async () => ({
          id: 'splash',
          type: 'page',
          url: 'file:///Applications/TradingView.app/Contents/Resources/splash.html',
          title: 'TradingView',
        }),
        evaluate: async () => { evaluated = true; },
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.target_is_chart, false);
    assert.equal(result.api_available, false);
    assert.equal(evaluated, false);
  });
});

describe('probeCdpVersion', () => {
  it('returns null within the deadline when the port accepts but never answers', async () => {
    // A TCP listener that accepts connections and stays silent — the shape of a
    // stalled Electron network service or an app mid-shutdown.
    const sockets = new Set();
    const server = net.createServer((socket) => { sockets.add(socket); /* accept and never respond */ });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const startedAt = Date.now();
    try {
      const result = await probeCdpVersion(port, 300);
      assert.equal(result, null);
      assert.ok(Date.now() - startedAt < 2000, 'probe must give up at its deadline, not hang');
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  });

  it('returns null immediately when nothing listens on the port', async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const result = await probeCdpVersion(port, 300);
    assert.equal(result, null);
  });
});
