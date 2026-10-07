'use strict';
/**
 * 极简 CDP 驱动：启动 chromium、连上页面 WebSocket、发命令。
 * 仅用于本工作区的端到端验证脚本。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Talks the Chrome DevTools Protocol over a WebSocket; `ws` is the only dependency. */
const WebSocket = require('ws');

/** Locate a Chrome/Chromium binary: explicit override, then Playwright's cache, then PATH. */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), '.cache', 'ms-playwright')
  ].filter(Boolean);
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    for (const name of entries.filter((n) => n.startsWith('chromium')).sort().reverse()) {
      for (const rel of [
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-win/chrome.exe'
      ]) {
        const candidate = path.join(root, name, rel);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('command', ['-v', name], { shell: true, encoding: 'utf8' });
    if (found.status === 0 && String(found.stdout).trim()) return String(found.stdout).trim();
  }
  throw new Error('no Chrome/Chromium found; set CHROME_PATH to its binary');
}

const CHROME = findChrome();

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function fetchJson(url) {
  const res = await fetch(url);
  return await res.json();
}

/** 启动 Chrome 并等到 DevTools 就绪；返回 { proc, port, kill }。 */
async function launchChrome(options) {
  const port = options.port || 9333;
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + (options.userDataDir || '/tmp/ptt-chrome'),
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationHints',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ];
  if (options.audioFile) args.splice(args.length - 1, 0, '--use-file-for-fake-audio-capture=' + options.audioFile);
  const proc = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const version = await fetchJson('http://127.0.0.1:' + port + '/json/version');
      if (version.webSocketDebuggerUrl) return { proc, port, version, stderr: () => stderr };
    } catch (error) { /* 尚未就绪 */ }
    await sleep(250);
  }
  proc.kill('SIGKILL');
  throw new Error('chrome did not start:\n' + stderr.slice(-2000));
}

/** 打开一个标签页并返回其 target 信息。 */
async function newTarget(port, url) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  return await res.json();
}

/** 一条 CDP 会话：命令/事件分发。 */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
  let nextId = 1;
  const pending = new Map();
  const handlers = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message + ' ' + JSON.stringify(message.error.data || '')));
      else entry.resolve(message.result);
      return;
    }
    const list = handlers.get(message.method);
    if (list) for (const fn of list) fn(message.params);
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  const on = (method, fn) => {
    const list = handlers.get(method) || [];
    list.push(fn);
    handlers.set(method, list);
  };
  return { ready, send, on, close: () => ws.close(), ws };
}

/** 在页面里执行表达式并取回 JSON 值。 */
async function evaluate(session, expression, awaitPromise) {
  const result = await session.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: awaitPromise !== false
  });
  if (result.exceptionDetails) {
    throw new Error('evaluate failed: ' + JSON.stringify(result.exceptionDetails).slice(0, 600));
  }
  return result.result.value;
}

async function waitFor(fn, options) {
  const timeout = (options && options.timeout) || 30000;
  const interval = (options && options.interval) || 200;
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error('waitFor timed out; last=' + String(last));
}

module.exports = { launchChrome, newTarget, connect, evaluate, waitFor, sleep, fetchJson, CHROME };
