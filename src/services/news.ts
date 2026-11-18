// News for a paired phone: only the client's own news queries reach the data server, with the pod's own key.
import { parse } from 'graphql';
import type { LoadedConfig } from '../config';
import type { GraphqlReply, PodServices } from '../plugin-api';

type NewsOperations = { isNewsOperation(operationName: string | null | undefined): boolean };
// The client's one list of the operations a news server may be sent, the app's own news queries included.
const newsOperations = () => require('mera-news-client/dist/lib/graphql/news-operations') as NewsOperations;

const globalFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const failure = (code: string, message: string): GraphqlReply => ({ errors: [{ message, extensions: { code } }] });

/** Null when every operation in the document is a named query on the list, else the reason. */
function refusal(op: unknown, isNews: NewsOperations['isNewsOperation']): string | null {
  const { query, operationName } = (op ?? {}) as { query?: unknown; operationName?: unknown };
  if (typeof query !== 'string') return 'The request has no query.';
  let operations;
  try {
    operations = parse(query).definitions.filter((d) => d.kind === 'OperationDefinition');
  } catch {
    return 'The query could not be parsed.';
  }
  if (operations.length === 0) return 'The request holds no operation.';
  if (operationName !== undefined && (typeof operationName !== 'string' || !isNews(operationName))) return 'That operation is not available here.';
  return operations.every((d) => d.operation === 'query' && d.name && isNews(d.name.value)) ? null : 'That operation is not available here.';
}

export function createNewsService(cfg: LoadedConfig, fetchFn: typeof fetch = globalFetch): PodServices['news'] {
  const { isNewsOperation } = newsOperations();
  const one = async (op: any): Promise<GraphqlReply> => {
    const why = refusal(op, isNewsOperation);
    if (why) return failure('NOT_ALLOWED', why);
    try {
      const res = await fetchFn(cfg.dataServer.graphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.dataServer.apiKey ? { 'x-api-key': cfg.dataServer.apiKey } : {}) },
        body: JSON.stringify({ query: op.query, variables: op.variables, operationName: op.operationName }),
        redirect: 'error',
      });
      // The server's own GraphQL errors, such as a validation failure, come through whatever its HTTP status.
      const reply = (await res.json().catch(() => null)) as GraphqlReply | null;
      if (reply && (reply.data !== undefined || reply.errors)) return reply;
      return failure('UPSTREAM_ERROR', `The data server answered ${res.status}.`);
    } catch {
      return failure('UPSTREAM_ERROR', 'The data server could not be reached.');
    }
  };
  return {
    // A batch is allowed only whole: one operation off the list refuses all of it before anything is sent.
    async graphql(body) {
      if (!Array.isArray(body)) return one(body);
      const bad = body.map((op) => refusal(op, isNewsOperation)).find((why) => why);
      if (bad || body.length === 0) return failure('NOT_ALLOWED', bad ?? 'The request holds no operation.');
      return Promise.all(body.map(one));
    },
  };
}
