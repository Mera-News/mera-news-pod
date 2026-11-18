import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertClientNotLoaded } from '../../src/host/boot-guard';

test('it names every module under the client directory that is loaded and not allowed', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pod-boot-')));
  const a = path.join(dir, 'a.js');
  const b = path.join(dir, 'b.js');
  fs.writeFileSync(a, 'module.exports = 1');
  fs.writeFileSync(b, 'module.exports = 2');
  assert.doesNotThrow(() => assertClientNotLoaded(dir, []));
  require(a);
  require(b);
  assert.throws(() => assertClientNotLoaded(dir, [a]), (e: Error) => e.message.includes(b) && !e.message.includes(a));
  assert.throws(() => assertClientNotLoaded(dir, []), (e: Error) => e.message.includes(a) && e.message.includes(b));
  assert.doesNotThrow(() => assertClientNotLoaded(dir, [a, b]));
  fs.rmSync(dir, { recursive: true });
});
