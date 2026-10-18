// mlch: the PATH of the person's login shell. An app opened from the Dock or
// Finder gets macOS's bare default (/usr/bin:/bin:/usr/sbin:/sbin), so tools
// the Terminal finds (Homebrew's ffmpeg, uv, node, git) were missing for the
// server and the Claude Code / Codex it runs. Read once at launch, merged in.
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const MARK = '__MLCH_PATH__';
/** Where tools usually are, for when the shell can't be asked. */
const USUAL = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];

/** The login shell's PATH, or undefined (no shell, too slow, odd output). */
function askShell({ shell = process.env.SHELL || '/bin/zsh', timeout = 5000, run = execFile } = {}) {
  return new Promise(resolve => {
    // -i -l: interactive login, so .zprofile and .zshrc both apply, as in Terminal.
    run(shell, ['-ilc', `printf '${MARK}%s${MARK}' "$PATH"`], { timeout, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' } }, (error, stdout) => {
      const found = typeof stdout === 'string' ? stdout.split(MARK)[1] : undefined;
      resolve(!error && found && found.includes('/') ? found : undefined);
    });
  });
}

/** Every entry once: the shell's first, then what the process had, then the usual places. */
function mergePaths(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const entry of (list || '').split(path.delimiter)) {
      if (entry && !seen.has(entry)) {
        seen.add(entry);
        out.push(entry);
      }
    }
  }
  return out.join(path.delimiter);
}

async function loginShellPath(options = {}) {
  if (process.platform === 'win32') return process.env.PATH;
  const shellPath = await askShell(options);
  return mergePaths(shellPath, process.env.PATH, USUAL.join(path.delimiter));
}

module.exports = { askShell, mergePaths, loginShellPath, USUAL };
