// mlch: the native audio helper (native/mlch-audio), from main's side.
//
// A separate binary, so its ML runtime (Core ML) never loads into an Electron
// process. Started on first use, JSON lines over stdio (protocol in
// native/mlch-audio/Sources/MlchAudioCore/Helper.swift). If it exits
// unexpectedly, waiting requests fail, captures end (an 'ended' event per
// session), and it is started again once; a second crash leaves it stopped
// until the app restarts.
const path = require('node:path');
const readline = require('node:readline');

const DEFAULT_TIMEOUT_MS = 60_000;

function createAudioHelper({ spawn, binary, args = [], log = () => {}, onEvent = () => {}, exists = () => true, restarts = 1 }) {
  let child;
  let lastId = 0;
  let crashes = 0;
  let stopping = false;
  const pending = new Map();
  const sessions = new Set();

  function available() {
    return !!binary && exists(binary) && crashes <= restarts;
  }

  function settleAll(error) {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  }

  function start() {
    if (child) return child;
    if (!binary || !exists(binary)) throw new Error('Local transcription is not installed in this build.');
    if (crashes > restarts) throw new Error('The audio helper stopped. Restart mlch to try again.');
    const proc = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => receive(line));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => log(line));
    proc.on('error', (error) => log(`audio helper: ${error.message}`));
    proc.on('exit', (code, signal) => {
      if (child === proc) child = undefined;
      settleAll(new Error('The audio helper stopped.'));
      for (const session of sessions) onEvent({ event: 'tap-ended', session, ...(stopping ? {} : { error: 'The audio helper stopped.' }) });
      sessions.clear();
      if (stopping) return;
      crashes += 1;
      log(`audio helper exited (${signal || code}); ${crashes <= restarts ? 'restarting' : 'not restarting'}`);
      if (crashes <= restarts) {
        try { start(); } catch (error) { log(error.message); }
      }
    });
    return proc;
  }

  function receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { log(`audio helper sent: ${line.slice(0, 200)}`); return; }
    if (message && Number.isInteger(message.id) && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result ?? {});
      else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'The audio helper failed.'));
      return;
    }
    if (message && typeof message.event === 'string') {
      if (message.event === 'tap-ended') sessions.delete(message.session);
      onEvent(message);
    }
  }

  /** One command; resolves to its result, rejects with the helper's error. */
  function request(cmd, payload = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
    let proc;
    try { proc = start(); } catch (error) { return Promise.reject(error); }
    const id = ++lastId;
    return new Promise((resolve, reject) => {
      const timer = timeout > 0 ? setTimeout(() => {
        pending.delete(id);
        reject(new Error(`The audio helper did not answer ${cmd} in time.`));
      }, timeout) : undefined;
      timer?.unref?.();
      pending.set(id, {
        resolve: (result) => {
          if (cmd === 'tap-start' && typeof result.session === 'string') sessions.add(result.session);
          if (cmd === 'tap-stop') sessions.delete(payload.session);
          resolve(result);
        },
        reject, timer,
      });
      try { proc.stdin.write(JSON.stringify({ ...payload, id, cmd }) + '\n'); }
      catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  /** Ends captures and the process (on quit). */
  async function stop() {
    if (!child) return;
    stopping = true;
    const proc = child;
    const killer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    killer.unref?.();
    await request('shutdown', {}, { timeout: 1500 }).catch(() => {});
    proc.stdin.end();
  }

  return { available, request, stop, running: () => !!child, sessions: () => [...sessions] };
}

/** Where the helper binary is: an override, inside the packaged app, or the dev build. */
function audioHelperPath({ packaged, resourcesPath, root, env = process.env }) {
  if (env.MLCH_AUDIO_HELPER) return env.MLCH_AUDIO_HELPER;
  if (packaged) return path.join(resourcesPath, 'mlch-audio');
  return path.join(root, 'native', 'mlch-audio', '.build', 'release', 'mlch-audio');
}

module.exports = { createAudioHelper, audioHelperPath };
