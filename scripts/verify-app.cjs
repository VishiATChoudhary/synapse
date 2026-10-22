// Fail before signing/notarization if a file filter removes part of the runnable app.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async (context) => {
  const root = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
    : path.join(context.appOutDir, 'resources', 'app');
  const required = [
    'app/main.mjs', 'app/preload.cjs', 'app/renderer/app.js', 'app/renderer/workspace.css',
    'app/node_modules/node-pty/lib/index.js', 'app/node_modules/node-pty/LICENSE',
    'app/node_modules/tweetnacl/nacl-fast.js', 'app/node_modules/@xterm/xterm/lib/xterm.mjs',
    'app/node_modules/@xterm/addon-fit/lib/addon-fit.mjs', 'public/workspace.mjs',
    'public/workspace.css', 'public/fonts/geist.woff2', 'tokens.css', 'discovery.mjs', 'install.mjs',
  ];
  const missing = required.filter((file) => !fs.existsSync(path.join(root, file)));
  if (missing.length) throw new Error(`Incomplete desktop bundle: ${missing.join(', ')}`);
  console.log(`Verified ${required.length} required desktop files before signing.`);
};
