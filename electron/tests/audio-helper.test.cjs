const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAudioHelper, audioHelperPath } = require('../lib/audio-helper.cjs');
const { createServerMessageHandler } = require('../lib/bridge-main.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A stand-in helper process: answers each request through `answer`, or crashes on demand. */
function fakeSpawn(answer) {
  const procs = [];
  const spawnFn = () => {
    const proc = new EventEmitter();
    proc.stdin = new PassThrough();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.kill = () => { proc.emit('exit', null, 'SIGKILL'); };
    proc.crash = () => proc.emit('exit', 1, null);
    proc.say = message => proc.stdout.write(JSON.stringify(message) + '\n');
    let buffered = '';
    proc.stdin.on('data', chunk => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        const reply = answer(request, proc);
        if (reply) proc.say({ id: request.id, ...reply });
      }
    });
    procs.push(proc);
    return proc;
  };
  return { spawn: spawnFn, procs };
}

test('requests settle from their own replies; events reach onEvent; stderr is logged', async () => {
  const events = [], logs = [];
  const fake = fakeSpawn((request, proc) => {
    if (request.cmd === 'tap-start') {
      setTimeout(() => proc.say({ event: 'chunk', session: 's1', path: '/tmp/mlch-audio/s1/00001.wav' }), 5);
      return { ok: true, result: { session: 's1' } };
    }
    if (request.cmd === 'transcribe') return { ok: false, error: 'The local model is not downloaded.' };
    proc.stderr.write('[mlch-audio] hello\n');
    return { ok: true, result: { model: 'present' } };
  });
  const helper = createAudioHelper({ spawn: fake.spawn, binary: '/bin/helper', log: line => logs.push(line), onEvent: e => events.push(e) });
  assert.deepEqual(await helper.request('status'), { model: 'present' });
  await assert.rejects(helper.request('transcribe', { path: '/x.wav' }), /not downloaded/);
  assert.deepEqual(await helper.request('tap-start', { target: 'all' }), { session: 's1' });
  await delay(20);
  assert.deepEqual(helper.sessions(), ['s1']);
  assert.equal(events[0].event, 'chunk');
  assert.ok(logs.includes('[mlch-audio] hello'));
  assert.equal(fake.procs.length, 1);
});

test('a crash fails waiting requests, ends captures, and restarts once only', async () => {
  const events = [];
  const fake = fakeSpawn((request) => (request.cmd === 'hang' ? undefined : { ok: true, result: request.cmd === 'tap-start' ? { session: 'cap' } : {} }));
  const helper = createAudioHelper({ spawn: fake.spawn, binary: '/bin/helper', onEvent: e => events.push(e) });
  await helper.request('tap-start');
  const waiting = helper.request('hang', {}, { timeout: 0 });
  fake.procs[0].crash();
  await assert.rejects(waiting, /stopped/);
  assert.deepEqual(events, [{ event: 'tap-ended', session: 'cap', error: 'The audio helper stopped.' }]);
  assert.equal(fake.procs.length, 2, 'restarted once');
  assert.ok(helper.available());
  await helper.request('status');
  fake.procs[1].crash();
  assert.equal(fake.procs.length, 2, 'not restarted a second time');
  assert.equal(helper.available(), false);
  await assert.rejects(helper.request('status'), /Restart mlch/);
});

test('a missing binary fails clearly without spawning, and requests time out', async () => {
  const fake = fakeSpawn(() => undefined);
  const missing = createAudioHelper({ spawn: fake.spawn, binary: '/nope', exists: () => false });
  assert.equal(missing.available(), false);
  await assert.rejects(missing.request('status'), /not installed/);
  assert.equal(fake.procs.length, 0);
  const silent = createAudioHelper({ spawn: fake.spawn, binary: '/bin/helper' });
  await assert.rejects(silent.request('status', {}, { timeout: 30 }), /did not answer status/);
});

test('the helper binary is found by override, in the packaged app, or in the dev build', () => {
  assert.equal(audioHelperPath({ packaged: false, root: '/r', env: { MLCH_AUDIO_HELPER: '/x' } }), '/x');
  assert.equal(audioHelperPath({ packaged: true, resourcesPath: '/App/Resources', root: '/r', env: {} }), '/App/Resources/mlch-audio');
  assert.equal(audioHelperPath({ packaged: false, root: '/r', env: {} }), '/r/native/mlch-audio/.build/release/mlch-audio');
});

test('main checks audio requests before they reach the helper', async () => {
  const calls = [];
  const handle = createServerMessageHandler({ shell: {}, dialog: {}, fs, getWindow: () => undefined, audio: async (request) => { calls.push(request); if (request.action === 'warm') throw new Error('The local model is not downloaded.'); return { ok: 1 }; } });
  const ask = async payload => (await handle({ type: 'bridge', id: 1, request: { type: 'audio', payload } })).result;
  assert.deepEqual(await ask({ action: 'status' }), { ok: true, value: { ok: 1 } });
  assert.equal((await ask({ action: 'rm' })).ok, false);
  assert.equal((await ask({ action: 'transcribe', path: 'relative.wav' })).ok, false);
  assert.equal((await ask({ action: 'transcribe', path: '/tmp/../etc/x.wav' })).ok, false);
  assert.equal((await ask({ action: 'tap-start', target: 'x; rm' })).ok, false);
  assert.equal((await ask({ action: 'tap-stop' })).ok, false);
  assert.deepEqual(await ask({ action: 'tap-start', target: 'us.zoom.xos', session: 'tap-1' }), { ok: true, value: { ok: 1 } });
  assert.deepEqual(await ask({ action: 'warm' }), { ok: false, error: 'The local model is not downloaded.' });
  assert.deepEqual(calls.slice(0, 2), [{ action: 'status' }, { action: 'tap-start', target: 'us.zoom.xos', session: 'tap-1' }]);
});

// The real helper, when it has been built (node scripts/build-native.mjs) and,
// for transcription, when its model is downloaded. Skipped otherwise.
const binary = audioHelperPath({ packaged: false, root: path.resolve(__dirname, '..', '..') });
const modelsDir = path.join(os.homedir(), 'Library', 'Application Support', 'mlch', 'models');
const built = process.platform === 'darwin' && fs.existsSync(binary);
const hasModel = built && fs.existsSync(modelsDir) && fs.readdirSync(modelsDir, { withFileTypes: true }).some((entry) => entry.name.startsWith('parakeet-ultra'));

test('the real helper answers status and shuts down cleanly', { skip: !built && 'helper not built' }, async () => {
  const helper = createAudioHelper({ spawn, binary, args: ['--models', modelsDir] });
  const status = await helper.request('status');
  assert.ok(['present', 'missing'].includes(status.model));
  assert.equal(typeof status.osSupportsTap, 'boolean');
  await assert.rejects(helper.request('dance'), /Known: status/);
  await helper.stop();
  await delay(200);
  assert.equal(helper.running(), false);
});

test('the real helper transcribes generated speech', { skip: !hasModel && 'model not downloaded', timeout: 120_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mlch-audio-test-'));
  try {
    const aiff = path.join(temp, 'x.aiff'), wav = path.join(temp, 'x.wav');
    execFileSync('say', ['-o', aiff, 'Local transcription keeps the audio on this Mac.']);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
    const helper = createAudioHelper({ spawn, binary, args: ['--models', modelsDir] });
    await helper.request('warm', {}, { timeout: 110_000 });
    const result = await helper.request('transcribe', { path: wav });
    assert.match(result.text.toLowerCase(), /local transcription keeps the audio on this mac/);
    assert.ok(result.ms < 2000, `took ${result.ms} ms`);
    await helper.stop();
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
