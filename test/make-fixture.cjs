'use strict';
/**
 * Convert any audio file Chrome can decode into the fixture the tests need:
 * 16 kHz mono PCM16 WAV. Uses Chrome itself (already a test dependency), so the
 * repository needs no ffmpeg, no sox, and no npm audio package.
 *
 *   node test/make-fixture.cjs <input-audio> [output.wav]
 */
const fs = require('node:fs');
const path = require('node:path');
const cdp = require('./cdp.cjs');

const input = process.argv[2];
const output = process.argv[3] || path.join(__dirname, 'fixtures', 'speech-16k.wav');
if (!input) {
  console.error('usage: node test/make-fixture.cjs <input-audio> [output.wav]');
  process.exit(2);
}

/** Same encoder the plugin uses: mono float samples -> 16 kHz PCM16 WAV. */
function encodeWave(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, Math.round(s * (s < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}

(async () => {
  let chrome; let session;
  try {
    const bytes = fs.readFileSync(input);
    const mime = /\.mp3$/i.test(input) ? 'audio/mpeg' : /\.wav$/i.test(input) ? 'audio/wav' : 'audio/mpeg';
    chrome = await cdp.launchChrome({ port: 9350, userDataDir: '/tmp/ptt-fixture-' + Date.now() });
    const target = await cdp.newTarget(chrome.port, 'about:blank');
    session = cdp.connect(target.webSocketDebuggerUrl);
    await session.ready;
    await session.send('Runtime.enable');

    const base64 = bytes.toString('base64');
    const mimeJson = JSON.stringify(mime);
    const b64Json = JSON.stringify(base64);
    // Chrome decodes here; the resample mirrors the plugin's own path exactly.
    const expr = [
      '(async () => {'
      , '  const raw = atob(' + b64Json + ');'
      , '  const buf = new Uint8Array(raw.length);'
      , '  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);'
      , '  const ctx = new AudioContext();'
      , '  const decoded = await ctx.decodeAudioData(buf.buffer);'
      , '  const frames = Math.max(1, Math.round(decoded.duration * 16000));'
      , '  const offline = new OfflineAudioContext(1, frames, 16000);'
      , '  const src = offline.createBufferSource();'
      , '  src.buffer = decoded;'
      , '  src.connect(offline.destination);'
      , '  src.start();'
      , '  const out = await offline.startRendering();'
      , '  await ctx.close();'
      , '  const ch = out.getChannelData(0);'
      , '  return { samples: Array.from(ch), duration: decoded.duration };'
      , '})()'
    ].join('\n');
    const result = await cdp.evaluate(session, expr);

    const wav = encodeWave(Float32Array.from(result.samples));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, wav);
    console.log('wrote ' + output + ' (' + wav.length + ' bytes, ' + result.duration.toFixed(1) + 's)');
  } catch (error) {
    console.error('convert failed: ' + ((error && error.stack) || error));
    process.exitCode = 1;
  } finally {
    try { if (session) session.close(); } catch (e) {}
    try { if (chrome) chrome.proc.kill('SIGKILL'); } catch (e) {}
  }
})();
