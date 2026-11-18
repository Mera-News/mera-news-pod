// The GraphQL client the data server calls go through. It owns error handling for the client's
// services, which only leave a breadcrumb when a query fails.
import { ApolloClient, ApolloLink, HttpLink, InMemoryCache } from '@apollo/client';
import { CombinedGraphQLErrors, ServerError } from '@apollo/client/errors';
import { ErrorLink } from '@apollo/client/link/error';
import type { Telemetry } from './telemetry';

export function createApolloClient(opts: { uri: string; fetch: typeof globalThis.fetch; apiKey?: string; telemetry: Telemetry; onUnauthorized: () => void }) {
  const errorLink = new ErrorLink(({ error, operation }) => {
    const name = operation.operationName;
    if (CombinedGraphQLErrors.is(error)) {
      const expected = (operation.getContext().expectedErrorCodes as readonly string[] | undefined) ?? [];
      for (const e of error.errors) {
        const code = e.extensions?.code as string | undefined;
        if (code && expected.includes(code)) opts.telemetry.addBreadcrumb({ category: 'graphql', message: `${name}: ${e.message}` });
        else opts.telemetry.captureException(new Error(`${name}: ${e.message}`), { extra: { code } });
        if (code === 'UNAUTHENTICATED' || e.extensions?.statusCode === 401) opts.onUnauthorized();
      }
      return;
    }
    opts.telemetry.captureException(error, { extra: { operation: name } });
    if (ServerError.is(error) && error.statusCode === 401) opts.onUnauthorized();
  });
  const http = new HttpLink({ uri: opts.uri, fetch: opts.fetch, headers: opts.apiKey ? { 'x-api-key': opts.apiKey } : undefined });
  return new ApolloClient({ link: ApolloLink.from([errorLink, http]), cache: new InMemoryCache() });
}
