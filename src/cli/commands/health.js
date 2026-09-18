import { register } from '../router.js';
import * as core from '../../core/health.js';

register('status', {
  description: 'Check CDP connection to TradingView',
  handler: async () => {
    const result = await core.healthCheck();
    if (result.success === false) {
      const err = new Error(result.message || result.error);
      err.code = result.error;
      throw err;
    }
    return result;
  },
});

register('launch', {
  description: 'Launch TradingView with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    'no-kill': { type: 'boolean', description: 'Do not kill existing instances' },
  },
  handler: (opts) => core.launch({
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: !opts['no-kill'],
  }),
});

register('ensure', {
  description: 'Ensure TradingView CDP and the chart renderer are responsive; relaunch only when needed',
  options: {
    timeout: { type: 'string', short: 't', description: 'Seconds to wait for the chart API before/after relaunch (default 30)' },
    'no-kill': { type: 'boolean', description: 'Relaunch without killing an existing TradingView main process' },
  },
  handler: (opts) => core.ensure({
    timeout: opts.timeout ? Number(opts.timeout) : undefined,
    no_kill: Boolean(opts['no-kill']),
  }),
});
