// One pod per home. The lock is an exclusive SQLite lock the operating system drops when the
// process dies, so a crash never leaves a lock behind to clear by hand.
import { DatabaseSync } from 'node:sqlite';

export function acquireLock(file: string): { release(): void } {
  const db = new DatabaseSync(file);
  try {
    db.exec('pragma locking_mode = EXCLUSIVE');
    db.exec('begin exclusive');
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5 || /locked|busy/i.test(String((error as Error).message))) {
      throw new Error('another pod is running on this home');
    }
    throw error;
  }
  return {
    release() {
      if (!db.isOpen) return;
      db.exec('rollback');
      db.close();
    },
  };
}
