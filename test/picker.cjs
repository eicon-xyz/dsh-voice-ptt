'use strict';
/**
 * 键位选择器验证：输入框提示可点开 → 选另一个键 → 新键生效、旧键失效、记忆保持。
 */
const fs = require('node:fs');
const cdp = require('./cdp.cjs');
const TOKEN = process.env.PTT_TOKEN || '';
const OUT = './picker.json';
const report = { checks: {}, steps: [], errors: [] };
function check(n, ok, d) { report.checks[n] = { ok: !!ok, detail: d }; console.log('[check] ' + (ok ? 'PASS' : 'FAIL') + ' ' + n + ' :: ' + JSON.stringify(d).slice(0, 600)); }
function step(n, d) { report.steps.push({ n, d }); console.log('[step] ' + n + ' :: ' + JSON.stringify(d).slice(0, 400)); }

function probeStatus() {
  const n = document.querySelector('[data-voice-ptt="status"]');
  if (!n) return null;
  return { phase: n.getAttribute('data-phase'), text: n.textContent, display: getComputedStyle(n).display };
}
function probeComposerFocus() {
  const e = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  if (e) { e.focus(); e.click(); }
  return !!e;
}
function probeHint() {
  const b = document.querySelector('[data-voice-ptt="hint"]');
  return b ? { text: b.textContent, visible: getComputedStyle(b).display !== 'none' } : null;
}
function probeClickHint() {
  const b = document.querySelector('[data-voice-ptt="hint"]');
  if (!b) return false;
  b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  b.click();
  return true;
}
function probePicker() {
  const p = document.querySelector('[data-voice-ptt="picker"]');
  if (!p) return null;
  return { text: p.textContent, keys: [...p.querySelectorAll('[data-voice-ptt-key]')].map((b) => b.getAttribute('data-voice-ptt-key')) };
}
function probeClickKey(code) {
  const b = document.querySelector('[data-voice-ptt-key="' + code + '"]');
  if (!b) return false;
  b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  b.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  b.click();
  return true;
}
function probeStored() {
  try { return localStorage.getItem('dsh-voice-ptt/hold-key'); } catch (e) { return 'ERR'; }
}
function probeClearStored() {
  try { localStorage.removeItem('dsh-voice-ptt/hold-key'); } catch (e) {}
  return true;
}
const CALL = (fn) => '(' + fn.toString() + ')()';
const CALL1 = (fn, a) => '(' + fn.toString() + ')(' + JSON.stringify(a) + ')';

(async () => {
  let chrome; let session;
  try {
    const AUDIO = process.env.PTT_AUDIO || require('node:path').join(__dirname, 'fixtures', 'speech-16k.wav');
    chrome = await cdp.launchChrome({ port: 9339, userDataDir: '/tmp/ptt-pick-' + Date.now(), audioFile: AUDIO });
    const t = await cdp.newTarget(chrome.port, (process.env.PTT_BASE || 'http://127.0.0.1:3081') + '/?token=' + encodeURIComponent(TOKEN));
    session = cdp.connect(t.webSocketDebuggerUrl);
    await session.ready;
    session.on('Runtime.exceptionThrown', (p) => { const d = p.exceptionDetails || {}; report.errors.push((d.exception && d.exception.description) || d.text); });
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await cdp.waitFor(() => cdp.evaluate(session, 'document.readyState === "complete"'), { timeout: 30000 });
    await cdp.waitFor(() => cdp.evaluate(session, CALL(function () { return !!document.querySelector('style[data-plugin="dsh-voice-ptt"]'); })), { timeout: 60000, interval: 400 });
    await cdp.waitFor(() => cdp.evaluate(session, CALL(probeComposerFocus)), { timeout: 60000, interval: 400 });
    await cdp.sleep(2500);

    // P1: 默认提示出现，文案含默认键 F2。
    const hint = await cdp.waitFor(() => cdp.evaluate(session, CALL(probeHint)), { timeout: 15000, interval: 300 });
    step('hint', hint);
    check('P1.hint-shows-default-key', !!(hint && hint.visible && hint.text.indexOf('F2') !== -1), hint);

    // P2: 点开提示 → 出现候选键。
    await cdp.evaluate(session, CALL(probeClickHint));
    const picker = await cdp.waitFor(() => cdp.evaluate(session, CALL(probePicker)), { timeout: 8000, interval: 250 });
    step('picker', picker);
    const expect = ['F2', 'F4', 'Insert', 'ControlRight', 'ShiftRight'];
    const got = picker ? picker.keys : [];
    check('P2.picker-lists-options', expect.every((k) => got.indexOf(k) !== -1), picker);

    // P3: 选 F4 → 提示与存储都变。
    await cdp.evaluate(session, CALL1(probeClickKey, 'F4'));
    await cdp.sleep(900);
    const hint2 = await cdp.evaluate(session, CALL(probeHint));
    const stored = await cdp.evaluate(session, CALL(probeStored));
    step('after-pick', { hint: hint2, stored });
    check('P3.pick-updates-hint', !!(hint2 && hint2.text.indexOf('F4') !== -1), hint2);
    check('P4.pick-persisted', stored === 'F4', { stored });

    // P5: 新键 F4 生效（能录音）。
    const VK_F4 = 115;
    const f4 = (type) => session.send('Input.dispatchKeyEvent', { type, code: 'F4', key: 'F4', windowsVirtualKeyCode: VK_F4, nativeVirtualKeyCode: VK_F4, modifiers: 0 });
    await cdp.evaluate(session, CALL(probeComposerFocus));
    await cdp.sleep(400);
    await f4('rawKeyDown');
    await cdp.sleep(2500);
    const during = await cdp.evaluate(session, CALL(probeStatus));
    await cdp.sleep(2500);
    await f4('keyUp');
    await cdp.sleep(1000);
    step('f4-records', during);
    check('P5.new-key-works', !!(during && (during.phase === 'recording' || during.phase === 'requesting')), during);

    // P6: 旧键 F2 失效（不再触发录音）。
    const VK_F2 = 113;
    await cdp.waitFor(async () => {
      const s = await cdp.evaluate(session, CALL(probeStatus));
      return s && s.phase !== 'transcribing' ? true : null;
    }, { timeout: 120000, interval: 600 });
    await cdp.evaluate(session, CALL(probeComposerFocus));
    await cdp.sleep(400);
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'F2', key: 'F2', windowsVirtualKeyCode: VK_F2, nativeVirtualKeyCode: VK_F2, modifiers: 0 });
    await cdp.sleep(2000);
    const f2status = await cdp.evaluate(session, CALL(probeStatus));
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'F2', key: 'F2', windowsVirtualKeyCode: VK_F2, nativeVirtualKeyCode: VK_F2, modifiers: 0 });
    await cdp.sleep(500);
    step('f2-after-switch', f2status);
    const stillRec = f2status && (f2status.phase === 'recording' || f2status.phase === 'requesting');
    check('P6.old-key-inactive', !stillRec, f2status);

    check('P7.no-exceptions', report.errors.length === 0, { errors: report.errors.slice(0, 4) });
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    const failed = Object.keys(report.checks).filter((k) => !report.checks[k].ok);
    console.log('REPORT ' + OUT + ' failed=' + failed.length);
    if (failed.length) console.log('FAILED: ' + failed.join(', '));
    process.exitCode = failed.length === 0 ? 0 : 2;
  } catch (error) {
    report.errors.push(String((error && error.stack) || error));
    console.error('FATAL ' + ((error && error.stack) || error));
    try { fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); } catch (e) {}
    process.exitCode = 1;
  } finally {
    try { if (session) session.close(); } catch (e) {}
    try { if (chrome) chrome.proc.kill('SIGKILL'); } catch (e) {}
  }
})();
