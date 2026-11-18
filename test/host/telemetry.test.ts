import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRedactor, createTelemetry } from '../../src/host/telemetry';

test('a secret is replaced by a literal match wherever it appears, including regex characters', () => {
  const redact = createRedactor(['sk-a.b+c', 'k2']);
  assert.equal(redact('key sk-a.b+c and sk-a.b+c again, also k2'), 'key [redacted] and [redacted] again, also [redacted]');
  assert.equal(redact('sk-aXb+c is not it'), 'sk-aXb+c is not it');
  assert.equal(createRedactor([''])('abc'), 'abc');
});

test('every line the sink gets is redacted, errors and context included', () => {
  const lines: string[] = [];
  const t = createTelemetry(createRedactor(['SECRET']), (_l, line) => lines.push(line));
  t.captureException(new Error('bad key SECRET'), { extra: { header: 'Bearer SECRET' } });
  t.captureMessage('hello SECRET');
  t.addBreadcrumb({ message: 'SECRET' });
  t.captureMessage('visible', { level: 'warning' });
  assert.ok(lines.length >= 3);
  assert.ok(lines.every((l) => !l.includes('SECRET')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('[redacted]')));
});

test('breadcrumbs stay below the default level', () => {
  const lines: string[] = [];
  const t = createTelemetry((s) => s, (_l, line) => lines.push(line));
  t.addBreadcrumb({ message: 'quiet' });
  assert.deepEqual(lines, []);
});
