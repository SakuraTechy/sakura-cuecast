import { build } from 'esbuild';
import { cp, mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.join(extensionDir, 'dist');
const contentScripts = [
  'bridge.js',
  'selector-core.js',
  'recorder.js',
  'player.js',
];

const buildOptions = {
  bundle: true,
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  platform: 'browser',
  target: ['chrome110'],
};

async function copyStaticAssets() {
  await Promise.all([
    cp(path.join(extensionDir, 'manifest.json'), path.join(outputDir, 'manifest.json')),
    cp(path.join(extensionDir, '_locales'), path.join(outputDir, '_locales'), { recursive: true }),
    cp(path.join(extensionDir, 'icons'), path.join(outputDir, 'icons'), { recursive: true }),
    cp(path.join(extensionDir, 'popup'), path.join(outputDir, 'popup'), {
      recursive: true,
      filter: (source) => path.basename(source) !== 'popup.js',
    }),
  ]);
}

async function assertReleaseLayout() {
  const requiredFiles = [
    'manifest.json',
    'background.js',
    'content/bridge.js',
    'content/selector-core.js',
    'content/recorder.js',
    'content/player.js',
    'popup/popup.html',
    'popup/popup.css',
    'popup/popup.js',
  ];
  await Promise.all(requiredFiles.map((file) => access(path.join(outputDir, file))));
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(path.join(outputDir, 'content'), { recursive: true });
await copyStaticAssets();

await build({
  ...buildOptions,
  entryPoints: [path.join(extensionDir, 'background.js')],
  outfile: path.join(outputDir, 'background.js'),
  format: 'esm',
});

await Promise.all(contentScripts.map((file) => build({
  ...buildOptions,
  entryPoints: [path.join(extensionDir, 'content', file)],
  outfile: path.join(outputDir, 'content', file),
  // These files run as independent page-world/content-script programs. Keep
  // their separate execution contexts and injection order unchanged.
  format: 'iife',
})));

await build({
  ...buildOptions,
  entryPoints: [path.join(extensionDir, 'popup', 'popup.js')],
  outfile: path.join(outputDir, 'popup', 'popup.js'),
  format: 'iife',
});

await assertReleaseLayout();
console.log(`Built production extension to ${outputDir}`);
