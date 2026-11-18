// One pod per home. The lock is an exclusive SQLite lock the operating system drops when the
// process dies, so a crash never leaves a lock behind to clear by hand.
import { DatabaseSync } from 'node:sqlite';

export function acquireLock(file: string): { release(): void } {
  const db = new DatabaseSync(file);
  try {
    db.exec('pragma locking_mode = EXCLUSIVE');
    // In exclusive locking mode a connection keeps its lock after its first write until it closes,
    // so the lock does not depend on a transaction staying open on an empty file.
    db.exec('begin exclusive');
    db.exec('create table if not exists holder (pid integer)');
    db.exec('delete from holder');
    db.prepare('insert into holder (pid) values (?)').run(process.pid);
    db.exec('commit');
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String((error as Error).message))) {
      throw new Error('another pod is running on this home');
    }
    throw error;
  }
  // Our own flag: DatabaseSync.isOpen is missing on the oldest Node the pod supports.
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      db.close();
    },
  };
}
