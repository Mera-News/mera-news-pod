import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertHostShape } from '../../src/host/index';

const required = { env: {}, appState: {}, sentry: {}, fetch: {}, asyncStorage: {}, secureStore: {}, getLocales: {}, auth: {}, apolloClient: {}, createDatabaseAdapter: {}, i18n: {} };

test('a host with every required member and known optional ones passes', () => {
  assertHostShape({ ...required, llmTransport: {}, netInfo: {} });
});

test('a misspelt member and a missing one are both named', () => {
  const { secureStore: _drop, ...rest } = required;
  assert.throws(() => assertHostShape({ ...rest, secureStorage: {} }), /missing secureStore, unknown secureStorage/);
});
