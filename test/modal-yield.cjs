'use strict';
/**
 * 弹窗让键验证：打开真实弹窗（快捷键面板，Ctrl+/）后按 F2，不应开始录音。
 * 上一轮 S4 失败是因为测试没能打开菜单（menuOpen:false），前提没成立。
 */
const fs = require('node:fs');
const path = require('node:path');
const cdp = require('./cdp.cjs');
const TOKEN = process.env.PTT_TOKEN || '';
const OUT = process.env.PTT_OUT || path.join(__dirname, 'modal.json');
const report = { checks: {}, steps: [], errors: [], probes: {} };
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
function probeModal() {
  const m = document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]');
  return m ? { present: true, text: (m.innerText || '').slice(0, 80) } : { present: false };
}
function probeCloseModal() {
  const m = document.querySelector('[role="dialog"][aria-modal="true"], [role="menu"]');
  // 走真实的关闭路径：对活动元素派发 Escape。
  const target = document.activeElement || document.body;
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
  return !!m;
}
const CALL = (fn) => '(' + fn.toString() + ')()';

(async () => {
  let chrome; let session;
  try {
    chrome = await cdp.launchChrome({ port: 9337, userDataDir: '/tmp/ptt-modal-' + Date.now() });
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

    const CTRL = 2;
    // 用真实快捷键打开快捷键面板（Ctrl+/）。
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Slash', key: '/', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191, modifiers: CTRL });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Slash', key: '/', windowsVirtualKeyCode: 191, nativeVirtualKeyCode: 191, modifiers: 0 });
    const modal = await cdp.waitFor(async () => {
      const m = await cdp.evaluate(session, CALL(probeModal));
      return m && m.present ? m : null;
    }, { timeout: 10000, interval: 300 });
    report.probes.modalOpen = modal;
    step('modal-open', modal);
    check('M0.modal-really-open', !!modal && modal.present, modal);

    // 弹窗打开时按 F2：不应开始录音。
    const VK_F2 = 113;
    await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'F2', key: 'F2', windowsVirtualKeyCode: VK_F2, nativeVirtualKeyCode: VK_F2, modifiers: 0 });
    await cdp.sleep(2000);
    const during = await cdp.evaluate(session, CALL(probeStatus));
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'F2', key: 'F2', windowsVirtualKeyCode: VK_F2, nativeVirtualKeyCode: VK_F2, modifiers: 0 });
    await cdp.sleep(600);
    report.probes.statusDuringModal = during;
    const captured = during && (during.phase === 'recording' || during.phase === 'requesting' || during.phase === 'transcribing');
    check('M1.F2-yields-to-modal', !captured, during);
    step('during-modal', during);

    // 关闭弹窗后 F2 应恢复工作（证明让键是条件性的，不是永久失效）。
    await cdp.evaluate(session, CALL(probeCloseModal));
    await cdp.sleep(900);
    const closed = await cdp.evaluate(session, CALL(probeModal));
    report.probes.afterClose = closed;
    if (!closed.present) {
      await cdp.evaluate(session, CALL(probeComposerFocus));
      await cdp.sleep(400);
      await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'F2', key: 'F2', windowsVirtualKeyCode: VK_F2, nativeVirtualKeyCode: VK_F2, modifiers: 0 });
      await cdp.sleep(2500);
      const resumed = await cdp.evaluate(session, CALL(probeStatus));
      await session.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'F2', key: 'F2', windowsVirtualKeyCode: VK_F2, nativeVirtualKeyCode: VK_F2, modifiers: 0 });
      await cdp.sleep(600);
      report.probes.statusAfterClose = resumed;
      check('M2.F2-works-again-after-close', !!(resumed && (resumed.phase === 'recording' || resumed.phase === 'requesting')), resumed);
      step('after-close', resumed);
    } else {
      check('M2.F2-works-again-after-close', false, { reason: 'modal did not close', closed });
    }

    check('M3.no-exceptions', report.errors.length === 0, { errors: report.errors.slice(0, 4) });
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
