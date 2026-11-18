// A small key-value store in one JSON file. A write goes to a temporary file that is renamed over
// the real one, so a crash leaves the old contents or the new, never half of either.
import fs from 'node:fs';
import path from 'node:path';

// 0600 for every store: the client may keep profile-derived values in either one.
export function createJsonStore(file: string, mode = 0o600) {
  const tmp = `${file}.tmp`;
  let chain: Promise<unknown> = Promise.resolve();
  // One operation at a time, and a failed one does not block the next.
  const run = <T>(fn: () => T): Promise<T> => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };

  // A missing file is an empty store. A file that cannot be read or parsed throws: treating it as
  // empty would let the next write replace everything in it.
  const read = (): Record<string, string> => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} does not hold a JSON object`);
    return parsed as Record<string, string>;
  };

  const write = (data: Record<string, string>) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(tmp, 'w', mode);
    try {
      fs.writeFileSync(fd, JSON.stringify(data));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  };

  return {
    get: (key: string) => run(() => read()[key] ?? null),
    set: (key: string, value: string) => run(() => write({ ...read(), [key]: value })),
    remove: (key: string) =>
      run(() => {
        const data = read();
        delete data[key];
        write(data);
      }),
  };
}

export function createAsyncStorage(file: string) {
  const store = createJsonStore(file);
  return { getItem: store.get, setItem: store.set, removeItem: store.remove };
}
