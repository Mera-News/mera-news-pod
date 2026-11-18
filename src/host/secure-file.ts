// The client's secure store on a file only the owner can read. A missing key is null; a file that
// cannot be read rejects, because the client treats null as "signed out" and would act on it.
import { createJsonStore } from './kv-file';

export function createSecureStore(file: string) {
  const store = createJsonStore(file);
  return { getItemAsync: store.get, setItemAsync: store.set, deleteItemAsync: store.remove };
}
