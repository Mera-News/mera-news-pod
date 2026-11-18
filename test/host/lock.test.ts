import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../../src/host/lock';

const fixture = path.join(__dirname, 'fixtures', 'hold-lock.ts');

function child(lockFile: string): { proc: ChildProcess; first: Promise<string> } {
  const proc = spawn(process.execPath, ['--import', 'tsx', fixture, lockFile], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  const first = new Promise<string>((resolve, reject) => {
    proc.stdout!.once('data', (d) => resolve(String(d).trim()));
    // 'close' comes after the child's output is read, so a child that reports and exits is not lost.
    proc.once('close', () => reject(new Error('child exited before reporting')));
  });
  return { proc, first };
}

test('a second acquire fails while held, and works after release', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-lock-'));
  const file = path.join(dir, 'pod.lock.db');
  const held = acquireLock(file);
  assert.throws(() => acquireLock(file), /another pod is running on this home/);
  held.release();
  held.release();
  acquireLock(file).release();
  fs.rmSync(dir, { recursive: true });
});

test('a second process is refused, and after the holder is killed with SIGKILL the lock is free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-lock-'));
  const file = path.join(dir, 'pod.lock.db');
  const holder = child(file);
  assert.equal(await holder.first, 'held');

  assert.throws(() => acquireLock(file), /another pod is running on this home/);
  assert.equal(await child(file).first, 'refused: another pod is running on this home');

  const exited = new Promise((r) => holder.proc.once('exit', r));
  holder.proc.kill('SIGKILL');
  await exited;

  const again = acquireLock(file);
  again.release();
  const restarted = child(file);
  assert.equal(await restarted.first, 'held');
  restarted.proc.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true });
});
