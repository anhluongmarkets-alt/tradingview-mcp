/**
 * Close TradingView promotional pop-ups (e.g. the "Black Friday" plan sale) that cover the chart and make
 * unattended reads fail (STMS 2026-11-25: OANDA:EURUSD verified read -> magnitude_mismatch at 08:15).
 *
 * Safety: only a dialog whose text reads as an advert is touched, and only its close control is clicked
 * (× / Close / Not now / No thanks). A button that could start a purchase (Upgrade, Get, Buy, Subscribe,
 * Start trial, a price) is never clicked. With no safe close control the page gets one Escape key.
 * Some adverts have neither a close control nor an Escape handler (STMS 2026-11-26: the full-screen
 * "gopro" Black Friday dialog). If one is still open after the click / Escape, the dialog's own React
 * `onClose` handler is called — the same path its normal dismissal runs; no button is pressed.
 * The result is re-checked: a dialog that survives is reported in `still_open`, never as dismissed.
 * Best effort: never throws; callers carry on with their read either way.
 */
import { evaluate, getClient } from '../connection.js';

const STRONG_PROMO = /black\s*friday|cyber\s*monday|\d+\s*%\s*off|save\s+up\s+to|\bsale\b|special\s+offer|limited[-\s]time|biggest\s+(sale|discount)/i;
const WEAK_PROMO = /upgrade|discount|free\s+trial|\btrial\b|premium|\bplans?\b|subscription|\bdeal\b|\boffer\b/i;
// Dialogs the desk opens on purpose: never touch these unless the text is unmistakably an advert.
const WORK_DIALOG = /create alert|edit alert|pine|indicators|symbol search|chart settings|properties|rename|save (layout|script)|load layout|replay|compare symbol/i;
const CLOSE_WORDS = /^(×|✕|✖|x|close|dismiss|not now|no,? thanks|maybe later|skip|later)$/i;
const CLOSE_ATTR = /close|dismiss|not[-_\s]?now|no[-_\s]?thanks|later|skip/i;
const PURCHASE = /upgrade|subscribe|\bbuy\b|\bget\b|start|claim|\btry\b|checkout|\bpay\b|purchase|\bplans?\b|\boffer\b|\bdeal\b|continue|\$|€|£|%/i;

export function isPromoDialog({ text = '' } = {}) {
  if (STRONG_PROMO.test(text)) return true;
  if (WORK_DIALOG.test(text)) return false;
  return WEAK_PROMO.test(text);
}

/** Index of the button that closes the dialog, or -1. Never a button that could start a purchase. */
export function pickCloseButton(buttons = []) {
  const safe = buttons.map((b, i) => ({ ...b, i })).filter(b => !PURCHASE.test(String(b.text || '')) && !PURCHASE.test(String(b.label || '').replace(/close/i, '')));
  const byWord = safe.find(b => CLOSE_WORDS.test(String(b.text || '').trim()) || CLOSE_WORDS.test(String(b.label || '').trim()));
  if (byWord) return byWord.i;
  const byAttr = safe.find(b => CLOSE_ATTR.test(String(b.label || '')) || CLOSE_ATTR.test(String(b.dataName || '')) || /close/i.test(String(b.cls || '')));
  if (byAttr) return byAttr.i;
  // An icon-only button in the dialog's top-right corner is the close cross.
  const corner = safe.find(b => !String(b.text || '').trim() && b.hasIcon && b.cornerTop <= 80 && b.cornerRight <= 80);
  return corner ? corner.i : -1;
}

const COLLECT = `(() => {
  const vis = e => { const s = getComputedStyle(e); const b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0 && b.width > 200 && b.height > 120; };
  const seen = new Set();
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-dialog-name], [class*="dialog"], [class*="modal"], [class*="popup"]')]
    .filter(vis).filter(d => { for (const s of seen) if (s.contains(d)) return false; seen.add(d); return true; });
  return dialogs.slice(0, 6).map((d, i) => {
    d.setAttribute('data-stms-dlg', String(i));
    const box = d.getBoundingClientRect();
    return { i, text: (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 400),
      buttons: [...d.querySelectorAll('button, [role="button"], a[href], [data-name="close"], [class*="close"]')].slice(0, 30).map((b, j) => {
        b.setAttribute('data-stms-btn', i + '-' + j);
        const r = b.getBoundingClientRect();
        return { text: (b.innerText || '').trim().slice(0, 40), label: b.getAttribute('aria-label') || b.getAttribute('title') || '', dataName: b.getAttribute('data-name') || '',
          cls: String(b.className || '').slice(0, 80), hasIcon: !!b.querySelector('svg'), cornerTop: Math.round(r.top - box.top), cornerRight: Math.round(box.right - r.right) };
      }) };
  });
})()`;

// Indexes of the marked dialogs that are still visible.
const STILL_OPEN = `(() => {
  const shown = e => { const s = getComputedStyle(e); const b = e.getBoundingClientRect(); return e.isConnected && s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity !== 0 && b.width > 200 && b.height > 120; };
  return [...document.querySelectorAll('[data-stms-dlg]')].filter(shown).map(d => Number(d.getAttribute('data-stms-dlg')));
})()`;

// Call the nearest React `onClose` prop above the dialog element (its own dismiss path). Returns true if called.
export const reactCloseExpr = i => `(() => {
  const d = document.querySelector('[data-stms-dlg="${Number(i)}"]');
  if (!d) return false;
  const key = Object.keys(d).find(k => k.startsWith('__reactFiber'));
  let f = key ? d[key] : null;
  for (let n = 0; f && n < 15; n++, f = f.return) {
    const p = f.memoizedProps;
    if (p && typeof p.onClose === 'function') { p.onClose(); return true; }
  }
  return false;
})()`;

export async function dismissPromoDialogs({ _deps } = {}) {
  const run = _deps?.evaluate || evaluate;
  const sleep = _deps?.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const report = { dismissed: [], escape: false, still_open: [] };
  try {
    const dialogs = (await run(COLLECT)) || [];
    for (const d of dialogs) {
      if (!isPromoDialog(d)) continue;
      const k = pickCloseButton(d.buttons);
      if (k >= 0) {
        await run(`(() => { const b = document.querySelector('[data-stms-btn="${d.i}-${k}"]'); if (b) b.click(); return !!b; })()`);
        report.dismissed.push({ text: d.text.slice(0, 80), method: 'close_button' });
      } else {
        const client = await (_deps?.getClient || getClient)();
        for (const type of ['keyDown', 'keyUp']) await client.Input.dispatchKeyEvent({ type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        report.escape = true;
        report.dismissed.push({ text: d.text.slice(0, 80), method: 'escape' });
      }
    }
    if (report.dismissed.length) {
      await sleep(400);
      const open = async () => { const v = await run(STILL_OPEN); return Array.isArray(v) ? v : []; };
      const handled = new Map(dialogs.filter(isPromoDialog).map(d => [d.i, d]));
      let left = (await open()).filter(i => handled.has(i));
      if (left.length) {
        for (const i of left) {
          if (!(await run(reactCloseExpr(i)))) continue;
          const text = handled.get(i).text.slice(0, 80);
          const entry = report.dismissed.find(d => d.text === text);
          if (entry) { entry.first_try = entry.method; entry.method = 'react_onclose'; }
          else report.dismissed.push({ text, method: 'react_onclose' });
        }
        await sleep(400);
        left = (await open()).filter(i => handled.has(i));
      }
      report.still_open = left.map(i => handled.get(i).text.slice(0, 80));
      if (left.length) report.dismissed = report.dismissed.filter(d => !report.still_open.includes(d.text));
    }
  } catch (err) {
    report.error = err?.code || err?.message || String(err);
  } finally {
    try { await run('document.querySelectorAll("[data-stms-dlg],[data-stms-btn]").forEach(e => { e.removeAttribute("data-stms-dlg"); e.removeAttribute("data-stms-btn"); })'); } catch { /* page gone */ }
  }
  return report;
}
