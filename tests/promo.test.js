import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPromoDialog, pickCloseButton, dismissPromoDialogs } from '../src/core/promo.js';

describe('promo dialog detection', () => {
  it('flags plan-sale adverts', () => {
    assert.equal(isPromoDialog({ text: 'Black Friday — up to 70% off all plans. Upgrade now' }), true);
    assert.equal(isPromoDialog({ text: 'Cyber Monday deal: Premium for less' }), true);
    assert.equal(isPromoDialog({ text: 'Start your free trial of Essential' }), true);
  });
  it('leaves desk work dialogs alone', () => {
    assert.equal(isPromoDialog({ text: 'Create alert on OANDA:EURUSD Condition Crossing' }), false);
    assert.equal(isPromoDialog({ text: 'Indicators, metrics and strategies' }), false);
    assert.equal(isPromoDialog({ text: 'Chart settings Symbol Status line Scales' }), false);
    assert.equal(isPromoDialog({ text: '' }), false);
  });
});

describe('close button choice', () => {
  it('never picks a purchase button', () => {
    assert.equal(pickCloseButton([{ text: 'Upgrade now' }, { text: 'Get 70% off' }, { text: 'Start free trial' }]), -1);
    assert.equal(pickCloseButton([{ text: 'Continue', label: '' }]), -1);
  });
  it('picks the close cross or a decline button', () => {
    assert.equal(pickCloseButton([{ text: 'Upgrade now' }, { text: '', label: 'Close', hasIcon: true }]), 1);
    assert.equal(pickCloseButton([{ text: 'Get the deal' }, { text: 'Not now' }]), 1);
    assert.equal(pickCloseButton([{ text: 'Explore plans' }, { text: '', dataName: 'close' }]), 1);
    assert.equal(pickCloseButton([{ text: 'Upgrade' }, { text: '', hasIcon: true, cornerTop: 12, cornerRight: 10 }]), 1);
  });
  it('ignores an icon button that is not in the corner', () => {
    assert.equal(pickCloseButton([{ text: '', hasIcon: true, cornerTop: 300, cornerRight: 200 }]), -1);
  });
});

describe('dismissPromoDialogs', () => {
  const page = dialogs => {
    const calls = [];
    return { calls, evaluate: async expr => { calls.push(expr); return expr.includes('data-stms-dlg', 0) && expr.startsWith('(() => {\n  const vis') ? dialogs : true; } };
  };
  it('clicks only the close control of an advert', async () => {
    const p = page([{ i: 0, text: 'Black Friday 70% off', buttons: [{ text: 'Upgrade now' }, { text: '', label: 'Close', hasIcon: true }] },
                     { i: 1, text: 'Create alert on EURUSD', buttons: [{ text: 'Cancel' }] }]);
    const r = await dismissPromoDialogs({ _deps: { evaluate: p.evaluate, sleep: async () => {} } });
    assert.deepEqual(r.dismissed.map(d => d.method), ['close_button']);
    assert.ok(p.calls.some(c => c.includes('data-stms-btn="0-1"')));
    assert.ok(!p.calls.some(c => c.includes('data-stms-btn="0-0"')), 'Upgrade never clicked');
    assert.ok(!p.calls.some(c => c.includes('data-stms-btn="1-')), 'work dialog untouched');
  });
  it('falls back to Escape when no safe close control exists', async () => {
    const keys = [];
    const p = page([{ i: 0, text: 'Cyber Monday sale', buttons: [{ text: 'Get the offer' }] }]);
    const r = await dismissPromoDialogs({ _deps: { evaluate: p.evaluate, sleep: async () => {}, getClient: async () => ({ Input: { dispatchKeyEvent: async e => keys.push(e.type) } }) } });
    assert.equal(r.escape, true);
    assert.deepEqual(keys, ['keyDown', 'keyUp']);
  });
  it('never throws when the page is gone', async () => {
    const r = await dismissPromoDialogs({ _deps: { evaluate: async () => { throw Object.assign(new Error('x'), { code: 'mcp_disconnected' }); } } });
    assert.equal(r.error, 'mcp_disconnected');
    assert.deepEqual(r.dismissed, []);
  });
});
