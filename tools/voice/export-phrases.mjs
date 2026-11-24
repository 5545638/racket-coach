#!/usr/bin/env node
// Writes tools/voice/phrases.json: every phrase the app can speak.
// Usage (from app/): npm run voice:export
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..', 'app');
// Vite lives in app/node_modules; this script is outside app/.
const vitePath = createRequire(join(appDir, 'package.json')).resolve('vite');
const { runnerImport } = await import(pathToFileURL(vitePath).href);

const { module } = await runnerImport(join(here, 'export-phrases.ts'), {
  root: appDir,
  configFile: false,
  logLevel: 'warn',
});
const data = module.exportPhrases();
const out = join(here, 'phrases.json');
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(`${out}: en ${data.phrases.en.length}, et ${data.phrases.et.length} phrases`);
