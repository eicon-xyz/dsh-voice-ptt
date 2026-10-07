'use strict';
/**
 * 修饰键候选验证：右侧修饰键作为「按住键」时必须能按住录音，
 * 且不能被「带修饰键不拦截」的规则挡掉（OWN_MODIFIER 的作用）；
 * 同时确认右 Ctrl 不会变成第二个修饰键（Ctrl+A 仍照常工作）。
 */
const fs = require('node:fs');
const path = require('node:path');
const cdp = require('./cdp.cjs');
const TOKEN = process.env.PTT_TOKEN || '';
const OUT = process.env.PTT_OUT || path.join(__dirname, 'modkey.json');
const report = { checks: {}, steps: [], errors: [] };
function check(n, ok, d) { report.checks[n] = { ok: !!ok, detail: d }; console.log('[check] ' + (ok ? 'PASS' : 'FAIL') + ' ' + n + ' :: ' + JSON.stringify(d).slice(0, 600)); }
function step(n, d) { report.steps.push({ n, d }); console.log('[step] ' + n + ' :: ' + JSON.stringify(d).slice(0, 400)); }

function probeStatus() {
  const n = document.querySelector('[data-voice-ptt=status]');
  if (!n) return null;
  return { phase: n.getAttribute('data-phase'), text: n.textContent, display: getComputedStyle(n).display };
}
function probeComposerFocus() {
  const e = document.querySelector('[contenteditable=true], textarea');
  if (e) { e.focus(); e.click(); }
  return !!e;
}
function probeHint() {
  const b = document.querySelector('[data-voice-ptt=hint]');
  return b ? { text: b.textContent } : null;
}
function probeClickHint() {
  const b = document.querySelector('[data-voice-ptt=hint]');
  if (b) b.click();
  return !!b;
}
function probeClickKey(code) {
  const b = document.querySelector('[data-voice-ptt-key=' + code + ']');
  if (!b) return false;
  b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  b.click();
  return true;
}
function probeDraft() {
  const e = document.querySelector('[contenteditable=true], textarea');
  return e ? (e.innerText || e.value || '') : null;
}
const CALL = (fn) => '(' + fn.toString() + ')()';
const CALL1 = (fn, a) => '(' + fn.toString() + ')(' + JSON.stringify(a) + ')';

(async () => {
  let chrome; let session;
  try {
    const AUDIO = process.env.PTT_AUDIO || path.join(__dirname, 'fixtures', 'speech-16k.wav');
    chrome = await cdp.launchChrome({ port: 9340, userDataDir: '/tmp/ptt-mod-' + Date.now(), audioFile: AUDIO });
    const t = await cdp.newTarget(chrome.port, (process.env.PTT_BASE || 'http://127.0.0.1:3081') + '/?token=' + encodeURIComponent(TOKEN));
    session = cdp.connect(t.webSocketDebuggerUrl);
    await session.ready;
    session.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails || {};
      report.errors.push((d.exception && d.exception.description) || d.text);
    });
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await cdp.waitFor(() => cdp.evaluate(session, 'document.readyState === "complete"'), { timeout: 30000 });
    await cdp.waitFor(() => cdp.evaluate(session, CALL(function () { return !!document.querySelector('style[data-plugin="dsh-voice-ptt"]'); })), { timeout: 60000, interval: 400 });
    await cdp.waitFor(() => cdp.evaluate(session, CALL(probeComposerFocus)), { timeout: 60000, interval: 400 });
    await cdp.sleep(2500);

    // 选「右 Ctrl」。
    await cdp.evaluate(session, CALL(probeClickHint));
    await cdp.sleep(800);
    await cdp.evaluate(session, CALL1(probeClickKey, 'ControlRight'));
    await cdp.sleep(900);
    const hint = await cdp.evaluate(session, CALL(probeHint));
    step('hint-after-pick', hint);
    check('K1.hint-shows-modifier', !!(hint && hint.text.indexOf('\u53f3 Ctrl') !== -1), hint);

    // 按住右 Ctrl → 应开始录音。
    await cdp.evaluate(session, CALL(probeComposerFocus));
    await cdp.sleep(400);
    const CTRL = 2;
    const rc = (type, mods) => session.send('Input.dispatchKeyEvent', { type, code: 'ControlRight', key: 'Control', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: mods });
    await rc('rawKeyDown', CTRL);
    await cdp.sleep(2500);
    const during = await cdp.evaluate(session, CALL(probeStatus));
    step('during-right-ctrl', during);
    check('K2.right-ctrl-records', !!(during && (during.phase === 'recording' || during.phase === 'requesting')), during);

    // 松开右 Ctrl → 转写并插入草稿。
    await cdp.sleep(3000);
    await rc('keyUp', 0);
    const draft = await cdp.waitFor(async () => {
      const d = await cdp.evaluate(session, CALL(probeDraft));
      const s = await cdp.evaluate(session, CALL(probeStatus));
      if ((d && d.length > 0) || (s && s.phase === 'error')) return { draft: d, status: s };
      return null;
    }, { timeout: 150000, interval: 600 });
    step('settled', draft);
    check('K3.right-ctrl-transcribes', !!(draft && draft.draft && draft.draft.length > 0), draft);

    // 右 Ctrl 按住时再按 A：应取消采集，让 Ctrl+A 照常（不是第二个修饰键）。
    await cdp.evaluate(session, CALL(probeComposerFocus));
    await cdp.sleep(400);
    await rc('rawKeyDown', CTRL);
    await cdp.sleep(2000);
    const comboMid = await cdp.evaluate(session, CALL(probeStatus));
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: CTRL });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyA', key: 'a', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: CTRL });
    await cdp.sleep(900);
    const comboAfter = await cdp.evaluate(session, CALL(probeStatus));
    await rc('keyUp', 0);
    await cdp.sleep(1200);
    step('combo', { mid: comboMid, after: comboAfter });
    const cancelled = comboAfter && comboAfter.phase !== 'recording' && comboAfter.phase !== 'transcribing';
    check('K4.combo-cancels-not-hijacks', !!(cancelled && comboMid && comboMid.phase === 'recording'), { mid: comboMid, after: comboAfter });

    check('K5.no-exceptions', report.errors.length === 0, { errors: report.errors.slice(0, 4) });
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
