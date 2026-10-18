const test = require('node:test');
const assert = require('node:assert/strict');
const { blockedHost } = require('../lib/screenshot.cjs');

test('screenshots never reach this Mac or a local network', () => {
  for (const host of ['localhost', 'app.localhost', 'printer.local', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.1.1', '[::1]', '::ffff:127.0.0.1', 'fd00::1', '']) {
    assert.equal(blockedHost(host), true, host);
  }
  for (const host of ['example.com', 'www.motion.com', '8.8.8.8', '172.32.0.1']) assert.equal(blockedHost(host), false, host);
});
