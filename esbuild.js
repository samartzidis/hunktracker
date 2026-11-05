// Bundles the extension into a single file, out/extension.js, together with its dependencies.
//
//   node esbuild.js               development build (source map, readable)
//   node esbuild.js --production  release build (whitespace and syntax minified, no source map)
//   node esbuild.js --watch       development build that rebuilds on every change
//
// Type checking is not esbuild's job: `npm run typecheck` (tsc --noEmit) does that.
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const root = __dirname;
const outDir = path.join(root, 'out');

/** isomorphic-git's CommonJS builds, exactly the ones the extension was developed and tested with. */
const gitBuild = rel => path.join(root, 'node_modules', 'isomorphic-git', rel);

/** Writes the license text of every package that ended up in the bundle. */
function writeThirdPartyLicenses(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(input);
    if (match) packages.set(match[1].replace('\\', '/'), path.join(root, input.slice(0, match.index + 'node_modules/'.length + match[1].length)));
  }
  const parts = ['Third-party software bundled into out/extension.js\n'];
  for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    let version = '';
    try { version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { /* no package.json */ }
    const licenseFile = fs.readdirSync(dir).find(f => /^(licen[cs]e|copying)/i.test(f));
    const text = licenseFile ? fs.readFileSync(path.join(dir, licenseFile), 'utf8').trim() : '(no license file in the package)';
    parts.push(`\n${'='.repeat(72)}\n${name}@${version}\n${'='.repeat(72)}\n${text}\n`);
  }
  fs.writeFileSync(path.join(outDir, 'THIRD_PARTY_LICENSES.txt'), parts.join(''));
  return packages.size;
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(outDir, 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'], // provided by the editor
  alias: {
    'isomorphic-git/managers': gitBuild('managers/index.cjs'),
    'isomorphic-git/models': gitBuild('models/index.cjs'),
    'isomorphic-git': gitBuild('index.cjs'),
  },
  sourcemap: production ? false : 'linked',
  // Identifiers stay readable: stack traces in the log are the only diagnostics users can send
  minifyWhitespace: production,
  minifySyntax: production,
  metafile: true,
  legalComments: 'none', // the licenses are collected into THIRD_PARTY_LICENSES.txt
  logLevel: 'info',
  plugins: [{
    name: 'licenses-and-summary',
    setup(build) {
      build.onEnd(result => {
        if (result.errors.length > 0 || !result.metafile) return;
        const count = writeThirdPartyLicenses(result.metafile);
        const kb = (fs.statSync(options.outfile).size / 1024).toFixed(0);
        console.log(`bundle: out/extension.js ${kb} KB, ${count} third-party package(s) licensed in THIRD_PARTY_LICENSES.txt`);
      });
    },
  }],
};

async function main() {
  // The old tsc output (one file per module) must not linger: the package ships out/*.js
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('watching for changes…');
  } else {
    await esbuild.build(options);
  }
}

main().catch(() => process.exit(1));
