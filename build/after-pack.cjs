// electron-builder manages node_modules itself (from package.json
// dependencies, which the staged app has none of) and leaves out
// .next/node_modules, the links Turbopack makes from hashed names to the
// server's external packages. Copy both from build/app as staged.
const fs = require('node:fs');
const path = require('node:path');

// SwiftPM's resource bundle for the audio helper is flat; codesign needs a
// macOS bundle (Contents/Info.plist, Contents/Resources). Foundation finds
// resources in either layout.
function macBundle(bundle) {
  if (!fs.existsSync(bundle) || fs.existsSync(path.join(bundle, 'Contents'))) return;
  const resources = path.join(bundle, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  for (const name of fs.readdirSync(bundle)) if (name !== 'Contents') fs.renameSync(path.join(bundle, name), path.join(resources, name));
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.mlch.mac.FluidAudio</string>
<key>CFBundleName</key><string>FluidAudio_FluidAudio</string>
<key>CFBundlePackageType</key><string>BNDL</string>
</dict></plist>
`);
}

function copyTree(from, to) {
  if (!fs.existsSync(from)) return;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
}

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources');
  macBundle(path.join(resources, 'FluidAudio_FluidAudio.bundle'));
  const staged = path.join(context.packager.projectDir, 'build', 'app');
  const app = path.join(resources, 'app');
  copyTree(path.join(staged, 'node_modules'), path.join(app, 'node_modules'));
  const source = path.join(staged, '.next', 'node_modules');
  if (!fs.existsSync(source)) return;
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
