import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/health.js';

export function registerHealthTools(server) {
  server.tool('tv_health_check', 'Check CDP connection to TradingView and return current chart state', {}, async () => {
    const result = await core.healthCheck();
    return jsonResult(result, result.success === false);
  });

  server.tool('tv_discover', 'Report which known TradingView API paths are available and their methods', {}, async () => {
    try { return jsonResult(await core.discover()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {}, async () => {
    try { return jsonResult(await core.uiState()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_launch', 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux.', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
  }, async ({ port, kill_existing }) => {
    try { return jsonResult(await core.launch({ port, kill_existing })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('tv_ensure', 'Ensure TradingView CDP and the chart renderer are responsive; relaunch only when needed.', {
    timeout: z.coerce.number().positive().optional().describe('Seconds to wait for the chart API before/after relaunch (default 30)'),
    no_kill: z.coerce.boolean().optional().describe('Relaunch without killing an existing TradingView main process (default false)'),
  }, async ({ timeout, no_kill }) => {
    try { return jsonResult(await core.ensure({ timeout, no_kill })); }
    catch (err) {
      return jsonResult({
        success: false,
        error: err.code || 'ensure_failed',
        message: err.message,
        action: err.action,
        reason: err.reason,
        pid: err.pid,
        elapsed_ms: err.elapsed_ms,
      }, true);
    }
  });
}
