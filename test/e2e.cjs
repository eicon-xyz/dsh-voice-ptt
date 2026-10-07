'use strict';
/**
 * 按住听写（push-to-talk）端到端验证。
 *
 * 真实 chromium 打开 GUI：按住快捷键 → 假麦克风录音 → 松开 → 转写 → 插入草稿。
 * 页面内探针用函数序列化下发，避免字符串转义问题。
 */
const fs = require('node:fs');
const cdp = require('./cdp.cjs');

const TOKEN = process.env.PTT_TOKEN || '';
const BASE = process.env.PTT_BASE || 'http://127.0.0.1:3081';
const path = require('node:path');
/** 16 kHz mono WAV containing speech; any such file works (see test/README.md). */
const AUDIO = process.env.PTT_AUDIO || path.join(__dirname, 'fixtures', 'speech-16k.wav');
const OUT = process.env.PTT_OUT || path.join(__dirname, 'result.json');
const HOLD_MS = Number(process.env.PTT_HOLD_MS || 5000);
// 单键按住听写：F2（见插件 client.js 的 HOLD_CODE）。
const KEY_CODE = process.env.PTT_CODE || 'F2';
const KEY_CHAR = process.env.PTT_KEY || 'F2';
const KEY_VK = Number(process.env.PTT_VK || 113);
const MODS = 0;

const report = { platform: null, steps: [], checks: {}, console: [], errors: [], transitions: [], drafts: [] };
function step(name, detail) {
  report.steps.push({ name, detail, at: new Date().toISOString() });
  console.log('[step] ' + name + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail).slice(0, 600)));
}
function check(name, ok, detail) {
  report.checks[name] = { ok: !!ok, detail };
  console.log('[check] ' + (ok ? 'PASS' : 'FAIL') + ' ' + name + ' :: ' + JSON.stringify(detail).slice(0, 700));
  return !!ok;
}

function probeBoot() {
  const b = globalThis.__DSH_BOOT__;
  return b && Array.isArray(b.entries) ? b.entries.map((e) => e.id) : null;
}
function probeStyle() {
  return !!document.querySelector('style[data-plugin="dsh-voice-ptt"]');
}
function probeComposer() {
  const card = document.querySelector('[data-composer-card]');
  const editable = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  return card && editable ? { card: true, editable: true } : null;
}
function probeFocus() {
  const e = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  if (e) { e.focus(); e.click(); }
  const card = document.querySelector('[data-composer-card]');
  return {
    active: document.activeElement ? document.activeElement.tagName : null,
    inCard: !!(card && document.activeElement && card.contains(document.activeElement))
  };
}
function probeDraft() {
  const e = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  return e ? (e.innerText || e.value || '') : null;
}
function probeStatus() {
  const n = document.querySelector('[data-voice-ptt="status"]');
  if (!n) return null;
  return {
    phase: n.getAttribute('data-phase'),
    text: n.textContent,
    display: getComputedStyle(n).display,
    stop: n.getAttribute('data-voice-ptt-stop')
  };
}
function probeSettled() {
  const n = document.querySelector('[data-voice-ptt="status"]');
  const e = document.querySelector('[contenteditable="true"], [contenteditable=""], textarea');
  const draft = e ? (e.innerText || e.value || '') : '';
  const phase = n ? n.getAttribute('data-phase') : null;
  if (draft && draft.length > 0) return { done: true, draft, phase };
  if (phase === 'error' || phase === 'hint') return { done: true, draft, phase, text: n ? n.textContent : '' };
  return null;
}
function probePlatform() {
  return { platform: navigator.platform, ua: navigator.userAgent, lang: navigator.language };
}

const CALL = (fn) => '(' + fn.toString() + ')()';

(async () => {
  let chrome; let session;
  try {
    step('launch', { audio: AUDIO, holdMs: HOLD_MS, keys: KEY_CODE });
    chrome = await cdp.launchChrome({ port: 9334, userDataDir: '/tmp/ptt-chrome-' + Date.now(), audioFile: AUDIO });
    const target = await cdp.newTarget(chrome.port, BASE + '/?token=' + encodeURIComponent(TOKEN));
    step('target', { id: target.id });

    session = cdp.connect(target.webSocketDebuggerUrl);
    await session.ready;
    session.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || []).map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' ');
      report.console.push({ type: params.type, text });
    });
    session.on('Runtime.exceptionThrown', (params) => {
      const d = params.exceptionDetails || {};
      report.errors.push((d.exception && d.exception.description) || d.text || 'unknown');
    });
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Log.enable');
    session.on('Log.entryAdded', (params) => report.console.push({ type: 'log.' + params.entry.level, text: params.entry.text }));

    await cdp.waitFor(() => cdp.evaluate(session, 'document.readyState === "complete"'), { timeout: 30000 });
    step('page-loaded');

    // __DSH_BOOT__ 由首个内联脚本写入，readyState 完成时通常已在；
    // 这里显式等待，避免与引导脚本竞态。
    const boot = await cdp.waitFor(async () => {
      const ids = await cdp.evaluate(session, CALL(probeBoot));
      return ids && ids.length > 0 ? ids : null;
    }, { timeout: 20000, interval: 200 });
    check('A1.bundle-registered', boot.indexOf('dsh-voice-ptt') !== -1, { entries: boot.length });

    await cdp.waitFor(() => cdp.evaluate(session, CALL(probeStyle)), { timeout: 60000, interval: 500 });
    check('A2.apply-ran', true, { styleInjected: true });

    const composer = await cdp.waitFor(() => cdp.evaluate(session, CALL(probeComposer)), { timeout: 90000, interval: 500 });
    step('composer-ready', composer);

    report.platform = await cdp.evaluate(session, CALL(probePlatform));
    step('platform', report.platform);

    const focus = await cdp.evaluate(session, CALL(probeFocus));
    step('focus', focus);
    // 焦点必须落进输入框卡片：单键按住只在聚焦输入框时接管。
    const focusedInCard = await cdp.waitFor(async () => {
      const f = await cdp.evaluate(session, CALL(probeFocus));
      return f && f.inCard ? f : null;
    }, { timeout: 15000, interval: 300 });
    step('focus-in-card', focusedInCard);
    await cdp.sleep(600);
    report.drafts.push({ when: 'before', text: await cdp.evaluate(session, CALL(probeDraft)) });

    const key = (type, m) => session.send('Input.dispatchKeyEvent', {
      type, code: KEY_CODE, key: KEY_CHAR,
      windowsVirtualKeyCode: KEY_VK, nativeVirtualKeyCode: KEY_VK, modifiers: m
    });

    // 按键前先确认状态条处于空闲。
    step('status-before', await cdp.evaluate(session, CALL(probeStatus)));

    await key('rawKeyDown', MODS);
    step('keydown-sent', { code: KEY_CODE, modifiers: MODS });

    // 采一段状态轨迹，直到出现非 idle（或超时）。
    const deadline = Date.now() + 25000;
    let sawActive = null;
    while (Date.now() < deadline) {
      const s = await cdp.evaluate(session, CALL(probeStatus));
      if (s && s.phase && s.phase !== 'idle') {
        report.transitions.push(s);
        sawActive = s;
        break;
      }
      await cdp.sleep(250);
    }
    check('B1.status-visible', !!(sawActive && sawActive.display !== 'none'), sawActive);
    step('status-after-keydown', sawActive);

    if (sawActive && (sawActive.phase === 'recording' || sawActive.phase === 'requesting')) {
      await cdp.sleep(HOLD_MS);
      const mid = await cdp.evaluate(session, CALL(probeStatus));
      report.transitions.push(mid);
      step('status-before-keyup', mid);
      await key('keyUp', 0);
      step('keyup-sent');

      const settled = await cdp.waitFor(() => cdp.evaluate(session, CALL(probeSettled)), { timeout: 150000, interval: 500 });
      report.drafts.push({ when: 'after', text: settled && settled.draft });
      step('settled', settled);
      check('C1.transcript-inserted', !!(settled && settled.draft && settled.draft.length > 0), settled);
    } else {
      // 未进入录音：可能是识别未就绪（插件应给出可见原因）或其他故障。
      const s = await cdp.evaluate(session, CALL(probeStatus));
      report.transitions.push(s);
      step('no-recording', s);
      await key('keyUp', 0);
      check('C1.transcript-inserted', false, { reason: 'never entered recording', status: s });
    }

    check('D1.no-silent-failure', !!(report.drafts.some((d) => d.when === 'after' && d.text) || report.transitions.some((t) => t && (t.phase === 'error' || t.phase === 'hint'))), { transitions: report.transitions });

    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    const failed = Object.keys(report.checks).filter((k) => !report.checks[k].ok);
    console.log('REPORT ' + OUT + ' failed=' + failed.length);
    if (failed.length) console.log('FAILED CHECKS: ' + failed.join(', '));
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
