'use strict';
/**
 * 草稿非空时听写：提示会隐藏，但 F2 必须仍然可用（常见用法：写到一半补一句）。
 */
const fs = require('node:fs');
const cdp = require('./cdp.cjs');
const TOKEN = process.env.PTT_TOKEN || '';
const OUT = './draft.json';
const report = { checks: {}, steps: [], errors: [] };
function check(n, ok, d) { report.checks[n] = { ok: !!ok, detail: d }; console.log('[check] ' + (ok ? 'PASS' : 'FAIL') + ' ' + n + ' :: ' + JSON.stringify(d).slice(0, 600)); }
function step(n, d) { report.steps.push({ n, d }); console.log('[step] ' + n + ' :: ' + JSON.stringify(d).slice(0, 400)); }

function probeStatus() {
  const n = document.querySelector('[data-voice-ptt="status"]');
  if (!n) return null;
  return { phase: n.getAttribute('data-phase'), text: n.textContent, display: getComputedStyle(n).display };
}
function probeDraft() {
  const e = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  return e ? (e.innerText || e.value || '') : null;
}
function probeComposerFocus() {
  const e = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  if (e) { e.focus(); e.click(); }
  return !!e;
}
function probeTypeText(t) {
  const e = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  if (!e) return null;
  e.focus();
  document.execCommand('insertText', false, t);
  return e.innerText || e.value || '';
}
const CALL = (fn) => '(' + fn.toString() + ')()';
const CALL1 = (fn, a) => '(' + fn.toString() + ')(' + JSON.stringify(a) + ')';

(async () => {
  let chrome; let session;
  try {
    // 必须喂假麦克风文件，否则静音会得到 "No speech recognized"（曾因此误判）。
    const AUDIO = process.env.PTT_AUDIO || require('node:path').join(__dirname, 'fixtures', 'speech-16k.wav');
    chrome = await cdp.launchChrome({ port: 9338, userDataDir: '/tmp/ptt-draft-' + Date.now(), audioFile: AUDIO });
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

    const VK_F2 = 113;
    const f2 = (type) => session.send('Input.dispatchKeyEvent', { type, code: 'F2', key: 'F2', windowsVirtualKeyCode: VK_F2, nativeVirtualKeyCode: VK_F2, modifiers: 0 });

    // 先输入一些文字，让草稿非空。
    const typed = await cdp.evaluate(session, CALL1(probeTypeText, '已有的草稿内容。'));
    await cdp.sleep(800);
    step('typed', typed);
    const emptyBefore = await cdp.evaluate(session, CALL(probeDraft));
    const hintNow = await cdp.evaluate(session, CALL(probeStatus));
    step('after-typing', { draft: emptyBefore, status: hintNow });
    check('N1.hint-hidden-when-draft-nonempty', !!(hintNow && hintNow.display === 'none'), hintNow);

    // 草稿非空时按住 F2：必须仍然录音。
    await f2('rawKeyDown');
    await cdp.sleep(2500);
    const during = await cdp.evaluate(session, CALL(probeStatus));
    step('during', during);
    check('N2.records-with-nonempty-draft', !!(during && (during.phase === 'recording' || during.phase === 'requesting')), during);
    await cdp.sleep(3500);
    await f2('keyUp');
    await cdp.sleep(1200);
    const after = await cdp.waitFor(async () => {
      const d = await cdp.evaluate(session, CALL(probeDraft));
      const s = await cdp.evaluate(session, CALL(probeStatus));
      const grew = (d || '').length > (emptyBefore || '').length;
      if (grew || (s && s.phase === 'error')) return { draft: d, status: s };
      return null;
    }, { timeout: 150000, interval: 600 });
    step('after', after);
    check('N3.transcript-appended', !!(after && after.draft && after.draft.length > (emptyBefore || '').length), { before: emptyBefore, after: after });
    check('N4.no-exceptions', report.errors.length === 0, { errors: report.errors.slice(0, 4) });

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
