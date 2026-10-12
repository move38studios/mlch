// electron-builder leaves out .next/node_modules: the links Turbopack makes
// from hashed names to the server's external packages (claude-agent-sdk,
// sharp, …). Recreate them inside the packaged app.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const source = path.join(context.packager.projectDir, '.next', 'node_modules');
  if (!fs.existsSync(source)) return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app');
  const target = path.join(app, '.next', 'node_modules');
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isSymbolicLink()) {
        fs.rmSync(dst, { force: true, recursive: true });
        fs.symlinkSync(fs.readlinkSync(src), dst);
      } else if (entry.isDirectory()) copy(src, dst);
    }
  };
  copy(source, target);
};
