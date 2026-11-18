// Refuses a database from a newer version, and keeps a copy of an older one before the client
// opens it and migrates it. It runs while the pod holds its lock, before the client opens the file,
// and it never writes, renames or deletes anything next to the database.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const HEADER = Buffer.from('SQLite format 3\0', 'latin1');

/** The schema version the database is at, read without creating any file. */
export function databaseVersion(dbPath: string): number {
  const wal = `${dbPath}-wal`;
  // Pages not yet copied back into the main file live in the WAL, the header page among them, so
  // only SQLite itself reads the version right then. Without a WAL the header in the file is current.
  if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      return Number((db.prepare('pragma user_version').get() as { user_version: number }).user_version);
    } finally {
      db.close();
    }
  }
  const header = Buffer.alloc(100);
  const fd = fs.openSync(dbPath, 'r');
  let read: number;
  try {
    read = fs.readSync(fd, header, 0, 100, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (read === 0) return 0;
  if (read < 100 || !header.subarray(0, 16).equals(HEADER)) throw new Error(`${dbPath} is not a SQLite database`);
  // The user_version field: 4 bytes, big-endian, at offset 60 of the header.
  return header.readUInt32BE(60);
}

export function guardDatabaseVersion(dbPath: string, codeVersion: number): void {
  if (!fs.existsSync(dbPath)) return;
  const found = databaseVersion(dbPath);
  if (found > codeVersion) throw new Error('this database was written by a newer version, refusing to start');
  if (found > 0 && found < codeVersion) {
    // The main file and its WAL are the whole database while nothing has it open; -shm is an index
    // SQLite rebuilds. Restore by copying both back as mera.db and mera.db-wal.
    for (const suffix of ['', '-wal']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, `${dbPath}.v${found}.bak${suffix}`);
    }
  }
}
