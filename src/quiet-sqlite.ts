// Node 22 marks node:sqlite experimental and says so on every start. The pod depends on it on
// purpose, so that one notice is dropped; every other warning still prints. Imported first.
const emit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message;
  if (typeof text === 'string' && text.startsWith('SQLite is an experimental feature')) return;
  return (emit as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

export {};
