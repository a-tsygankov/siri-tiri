import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const pick = (src) => /APP_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1];

test('sw.js and version.js declare the same APP_VERSION', () => {
  const app = pick(read('version.js'));
  const sw = pick(read('sw.js'));
  assert.ok(app, 'version.js has APP_VERSION');
  assert.equal(sw, app);
});
