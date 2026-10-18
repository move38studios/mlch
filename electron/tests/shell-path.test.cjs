const test = require('node:test');
const assert = require('node:assert/strict');
const { askShell, mergePaths } = require('../lib/shell-path.cjs');

test('the login shell PATH comes first, then what the app had, each entry once', () => {
  assert.equal(mergePaths('/opt/homebrew/bin:/usr/bin', '/usr/bin:/bin', '/usr/local/bin:/opt/homebrew/bin'), '/opt/homebrew/bin:/usr/bin:/bin:/usr/local/bin');
  assert.equal(mergePaths(undefined, '/usr/bin'), '/usr/bin');
});

test('reads the PATH between markers and ignores a shell that fails or prints nothing useful', async () => {
  const say = (stdout, error = null) => (_cmd, _args, _opts, done) => done(error, stdout);
  assert.equal(await askShell({ run: say('motd noise\n__MLCH_PATH__/opt/homebrew/bin:/usr/bin__MLCH_PATH__') }), '/opt/homebrew/bin:/usr/bin');
  assert.equal(await askShell({ run: say('', new Error('timeout')) }), undefined);
  assert.equal(await askShell({ run: say('no markers') }), undefined);
});

test('a real login shell answers', { skip: process.platform === 'win32' }, async () => {
  const found = await askShell({ timeout: 10000 });
  assert.ok(found && found.includes('/usr/bin'), String(found));
});
