import { originsOf, type RecordedRequest } from './recorder';

export { startFakeModel, defaultResponder, type FakeModel, type FakeModelOptions, type ChatRequestBody } from './fake-model';
export { startFakeDataServer, defaultSchemaPath, type FakeDataServer, type FakeDataServerOptions, type FakeArticle } from './fake-data-server';
export { originsOf, type RecordedRequest } from './recorder';

/** Every origin the given fakes were contacted on, so a test can assert nothing else was reached. */
export const recordedOrigins = (...fakes: { requests: readonly RecordedRequest[] }[]): string[] =>
  originsOf(fakes.flatMap((f) => f.requests));
