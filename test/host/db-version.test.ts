import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { databaseVersion, guardDatabaseVersion } from '../../src/host/db-version';

function make(version: number, wal: boolean): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-dbv-'));
  const file = path.join(dir, 'mera.db');
  const db = new DatabaseSync(file);
  if (wal) db.exec('pragma journal_mode = WAL');
  db.exec('create table t (a text); insert into t values (\'kept\')');
  db.exec(`pragma user_version = ${version}`);
  db.close();
  return { dir, file };
}
const snapshot = (dir: string) => Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n)).toString('base64')]));

test('no file is fine and creates nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-dbv-'));
  guardDatabaseVersion(path.join(dir, 'mera.db'), 5);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
});

for (const wal of [false, true]) {
  test(`a higher version is refused and every file stays byte-identical (wal ${wal})`, () => {
    const { dir, file } = make(9, wal);
    const before = snapshot(dir);
    assert.throws(() => guardDatabaseVersion(file, 5), /written by a newer version, refusing to start/);
    assert.deepEqual(snapshot(dir), before);
    fs.rmSync(dir, { recursive: true });
  });
}

/** A live WAL database whose last writes, the version bump included, are still only in the WAL,
 *  copied as a crash would leave it: main file, WAL and index, with the writer gone. */
function crashedWithWal(base: number, bumped: number): { dir: string; file: string } {
  const { dir, file } = make(base, true);
  const live = new DatabaseSync(file);
  live.exec('pragma wal_autocheckpoint = 0');
  live.exec("insert into t values ('in the wal')");
  live.exec(`pragma user_version = ${bumped}`);
  const crashed = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-dbv-'));
  for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(file + suffix, path.join(crashed, 'mera.db' + suffix));
  live.close();
  fs.rmSync(dir, { recursive: true });
  return { dir: crashed, file: path.join(crashed, 'mera.db') };
}

test('a version bump still only in the WAL is read from the WAL', () => {
  const { dir, file } = crashedWithWal(3, 9);
  assert.equal(fs.readFileSync(file).readUInt32BE(60), 3, 'the main file header still says 3');
  assert.equal(databaseVersion(file), 9);
  const before = snapshot(dir);
  assert.throws(() => guardDatabaseVersion(file, 5), /written by a newer version/);
  assert.deepEqual(snapshot(dir), before);
  fs.rmSync(dir, { recursive: true });
});

test('without a WAL the version is read from the header, and no file is created', () => {
  const { dir, file } = make(4, true);
  assert.deepEqual(fs.readdirSync(dir), ['mera.db']);
  assert.equal(databaseVersion(file), 4);
  assert.deepEqual(fs.readdirSync(dir), ['mera.db']);
  fs.rmSync(dir, { recursive: true });
});

test('a file that is not SQLite is refused, an empty one is version 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-dbv-'));
  fs.writeFileSync(path.join(dir, 'a.db'), 'not a database at all, but long enough to have a header of some kind....................................');
  assert.throws(() => databaseVersion(path.join(dir, 'a.db')), /not a SQLite database/);
  fs.writeFileSync(path.join(dir, 'b.db'), '');
  assert.equal(databaseVersion(path.join(dir, 'b.db')), 0);
  fs.rmSync(dir, { recursive: true });
});

test('a lower version is backed up with its WAL, and the old code opens the restored copy with every row', async () => {
  const { dir, file } = crashedWithWal(3, 3);
  const main = fs.readFileSync(file);
  const wal = fs.readFileSync(`${file}-wal`);
  guardDatabaseVersion(file, 5);
  assert.deepEqual(fs.readFileSync(`${file}.v3.bak`), main);
  assert.deepEqual(fs.readFileSync(`${file}.v3.bak-wal`), wal);
  assert.equal(fs.existsSync(`${file}.v3.bak-shm`), false);
  assert.deepEqual(fs.readFileSync(file), main, 'the original is untouched');

  // Restore as the docs say, then open it with WatermelonDB at the old schema version.
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'pod-dbv-'));
  fs.copyFileSync(`${file}.v3.bak`, path.join(restored, 'mera.db'));
  fs.copyFileSync(`${file}.v3.bak-wal`, path.join(restored, 'mera.db-wal'));
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Database, Model, Q, appSchema, tableSchema } = require('@nozbe/watermelondb');
  require('@nozbe/watermelondb/utils/common/logger').default.silence();
  const SQLiteAdapter = require('@nozbe/watermelondb/adapters/sqlite').default;
  /* eslint-enable @typescript-eslint/no-require-imports */
  class T extends Model {
    static table = 't';
  }
  const adapter = new SQLiteAdapter({
    dbName: path.join(restored, 'mera.db'),
    schema: appSchema({ version: 3, tables: [tableSchema({ name: 't', columns: [{ name: 'a', type: 'string' }] })] }),
  });
  const db = new Database({ adapter, modelClasses: [T] });
  const rows = (await db.get('t').query(Q.unsafeSqlQuery('select a from t order by rowid')).unsafeFetchRaw()) as { a: string }[];
  assert.deepEqual(rows.map((r) => r.a), ['kept', 'in the wal']);
  assert.equal(databaseVersion(path.join(restored, 'mera.db')), 3);
  fs.rmSync(dir, { recursive: true });
  fs.rmSync(restored, { recursive: true });
});

test('the same version, and a fresh file at version 0, make no backup', () => {
  for (const v of [5, 0]) {
    const { dir, file } = make(v, false);
    guardDatabaseVersion(file, 5);
    assert.deepEqual(fs.readdirSync(dir), ['mera.db']);
    fs.rmSync(dir, { recursive: true });
  }
});
