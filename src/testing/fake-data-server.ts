import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildSchema,
  defaultFieldResolver,
  execute,
  GraphQLError,
  Kind,
  parse,
  specifiedRules,
  validate,
  type ASTVisitor,
  type GraphQLSchema,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';
import { readBody, record, sendJson, type RecordedRequest } from './recorder';

/** One article as the server serves it. Only `_id` and `title` are required, the rest is filled in. */
export interface FakeArticle {
  _id: string;
  title: string;
  title_en?: string;
  description_en?: string;
  article_url?: string;
  country_code?: string | null;
  publication_name?: string;
  language_code?: string;
  pubDate?: string;
  story_key?: string | null;
  [key: string]: unknown;
}

export interface FakeDataServerOptions {
  /** Path of the real server's schema file. Every operation is validated against it. */
  schemaPath: string;
  /** Set: a missing or wrong `x-api-key` answers 401. Unset: open mode. */
  apiKey?: string;
  articles: FakeArticle[];
  /** Topic text (lower case, single spaces) to the ids it matches, in order. */
  topics: Record<string, string[]>;
  /** Ids served as top headlines, in order. Unset: every article. */
  headlines?: string[];
}

export interface FakeDataServer {
  /** Origin, for example `http://127.0.0.1:41234`. */
  origin: string;
  graphqlUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');

export const defaultSchemaPath = (): string =>
  process.env.MERA_DATA_SERVER_SCHEMA ??
  `${process.cwd()}/../mera-news-data-server/apps/mera-server-news-api/src/schema.gql`;

// An article without a pubDate is as new as the server: the client hides articles older than a few days.
const withDefaults = (a: FakeArticle, now: string) => ({
  article_url: `https://example.com/${a._id}`,
  title_en: a.title,
  description_en: `Details of ${a._id}`,
  country_code: null,
  publication_name: `Pub ${a._id}`,
  language_code: 'en',
  pubDate: now,
  story_key: null,
  clusters: [{ clusterId: `c-${a._id}`, confidence: 0.9, stableClusterId: `stable-${a._id}` }],
  maxClusterSize: 1,
  geo_tags: [],
  entities: [],
  ...a,
});

/** The same article in the shape of the server's plain article type. */
const asNewsArticle = (a: FakeArticle, now: string) => {
  const full = withDefaults(a, now);
  return {
    ...full,
    description: full.description_en,
    source_uri: full.article_url,
    type: 'article',
    publicationSourceId: `pub-${a._id}`,
    country: full.country_code,
    createdAt: full.pubDate,
    updatedAt: full.pubDate,
  };
};

const slug = (name: string) => norm(name).replace(/[^a-z0-9]+/g, '-');

/** A publication as the public server sends it: addresses are origin plus path, and no fetch error. */
const asSource = (name: string, country: string | null, now: string) => ({
  _id: `source-${slug(name)}`,
  newsPublisherId: `publisher-${slug(name)}`,
  publication_name: name,
  feed_url: `https://example.com/feeds/${slug(name)}.xml`,
  publication_url: `https://example.com/${slug(name)}`,
  country_code: country ?? 'XX',
  country_name: null,
  category: 'general',
  categories: null,
  type: 'rss',
  gated: false,
  is_active: true,
  last_fetch_error: null,
  createdAt: now,
  updatedAt: now,
});

const WINDOWS = [6, 12, 24, 48];

function resolversFor(options: FakeDataServerOptions) {
  const { articles, topics } = options;
  const now = new Date().toISOString();
  const served = options.headlines ? options.headlines.flatMap((id) => articles.filter((a) => a._id === id)) : articles;
  const byCountry = (code?: string | null) =>
    articles.filter((a) => !code || (a.country_code ?? '').toUpperCase() === code.toUpperCase());
  const headlineIds = (scope: string, code: string | null | undefined, limit: number) =>
    (scope === 'COUNTRY' ? byCountry(code).filter((a) => served.includes(a)) : served).slice(0, limit).map((a) => a._id);
  const hydrate = (articleIds: string[]) => ({
    articles: articleIds.flatMap((id) => {
      const found = articles.find((a) => a._id === id);
      return found ? [withDefaults(found, now)] : [];
    }),
    dailyLimitReached: false,
    resetAt: null,
  });
  // One publisher with one source per publication name the articles carry.
  const sources = () => {
    const byName = new Map<string, ReturnType<typeof asSource>>();
    for (const a of articles) {
      const full = withDefaults(a, now);
      if (!byName.has(full.publication_name)) byName.set(full.publication_name, asSource(full.publication_name, full.country_code, now));
    }
    return [...byName.values()];
  };

  return {
    articleIdsForPersona: ({ query }: { query: PersonaQuery }) => ({
      topicResults: query.topics.flatMap((t) => {
        const ids = (topics[norm(t.text)] ?? []).slice(0, t.limit ?? query.limitPerTopic);
        return ids.length === 0
          ? []
          : [
              {
                topicText: t.text,
                articleIds: ids,
                matchMeta: ids.map((id) => ({ articleId: id, vectorScore: 0.8, textScore: null, stableClusterId: `stable-${id}` })),
                nextCursor: null,
                hasNextPage: false,
              },
            ];
      }),
      headlineResults: (query.topHeadlines?.scopes ?? []).map((s) => {
        const ids = headlineIds(s.scope, s.countryCode, s.limit ?? query.topHeadlines?.limitPerScope ?? 10);
        return {
          scope: s.scope,
          countryCode: s.scope === 'COUNTRY' ? (s.countryCode ?? null) : null,
          articleIds: ids,
          clusterSizes: ids.map(() => 1),
          stableClusterIds: ids.map((id) => `stable-${id}`),
        };
      }),
    }),
    articlesForTopicsByIds: ({ articleIds }: { articleIds: string[] }) => hydrate(articleIds),
    articlesForStories: ({ articleIds }: { articleIds: string[] }) => hydrate(articleIds),
    // An unknown id is left out, as the server leaves out one whose links are mid-swap.
    clusterMembershipsForArticles: ({ articleIds }: { articleIds: string[] }) =>
      articleIds.flatMap((id) => {
        const found = articles.find((a) => a._id === id);
        return found ? [{ articleId: id, clusters: withDefaults(found, now).clusters }] : [];
      }),
    publicationSourcesForNewsPublisher: ({ publisherId }: { publisherId: string }) => ({
      publicationSources: sources().filter((src) => src.newsPublisherId === publisherId),
    }),
    searchPublishers: ({ query, first }: { query: string; first: number }) => {
      const hits = sources()
        .filter((src) => norm(src.publication_name).includes(norm(query)))
        .slice(0, first)
        .map((src) => ({ _id: src.newsPublisherId, name: src.publication_name, country_code: src.country_code, country_name: null, website_url: src.publication_url, subscription_uri: null, matchingSources: [src] }));
      return { publishers: hits, pageInfo: { endCursor: null, hasNextPage: false, pageSize: hits.length } };
    },
    recentArticleCount: ({ since }: { since?: string | null }) =>
      articles.filter((a) => !since || Date.parse(a.pubDate ?? now) >= Date.parse(since)).length,
    topHeadlinesForCountry: ({ countryCode, first, windowHours }: { countryCode?: string | null; first: number; windowHours: number }) => {
      if (!WINDOWS.includes(windowHours)) throw new GraphQLError(`windowHours must be one of ${WINDOWS.join(', ')}`, { extensions: { code: 'BAD_WINDOW' } });
      const code = countryCode?.toUpperCase() === 'GLOBAL' ? null : countryCode;
      const picked = byCountry(code).filter((a) => served.includes(a)).slice(0, first).map((a) => asNewsArticle(a, now));
      return {
        articles: picked,
        headlines: picked.map((article) => ({ article, clusterSize: 1, stableClusterId: `stable-${article._id}` })),
        editionBuiltAt: now,
        pageInfo: { endCursor: null, hasNextPage: false, pageSize: picked.length },
      };
    },
  };
}

// The public server's limit, so a client document it would refuse is refused here too: depth and
// field count follow fragments, and introspection is never counted.
const MAX_DEPTH = 12;
const MAX_FIELDS = 1000;
function queryLimits(context: ValidationContext): ASTVisitor {
  return {
    OperationDefinition(operation) {
      let fields = 0;
      let failure: string | null = null;
      const walk = (set: SelectionSetNode, depth: number, spreading: string[]) => {
        for (const sel of set.selections) {
          if (failure) return;
          if (sel.kind === Kind.FIELD) {
            if (sel.name.value === '__schema' || sel.name.value === '__type') continue;
            fields += 1;
            if (fields > MAX_FIELDS) failure = `Query selects more than the limit of ${MAX_FIELDS} fields`;
            else if (depth + 1 > MAX_DEPTH) failure = `Query is nested deeper than the limit of ${MAX_DEPTH} levels`;
            else if (sel.selectionSet) walk(sel.selectionSet, depth + 1, spreading);
          } else if (sel.kind === Kind.INLINE_FRAGMENT) {
            walk(sel.selectionSet, depth, spreading);
          } else if (!spreading.includes(sel.name.value)) {
            const fragment = context.getFragment(sel.name.value);
            if (fragment) walk(fragment.selectionSet, depth, [...spreading, sel.name.value]);
          }
        }
      };
      walk(operation.selectionSet, 0, []);
      if (failure) context.reportError(new GraphQLError(failure, { nodes: operation, extensions: { code: 'QUERY_TOO_COMPLEX' } }));
    },
  };
}

interface PersonaQuery {
  limitPerTopic: number;
  topics: { text: string; limit?: number | null }[];
  topHeadlines?: { limitPerScope: number; scopes: { scope: string; countryCode?: string | null; limit?: number | null }[] };
}

export async function startFakeDataServer(options: FakeDataServerOptions): Promise<FakeDataServer> {
  if (!existsSync(options.schemaPath)) {
    throw new Error(
      `There is no data server schema at ${options.schemaPath}. Set MERA_DATA_SERVER_SCHEMA to the schema.gql of mera-news-data-server (apps/mera-server-news-api/src/schema.gql), or check that repository out next to this one.`,
    );
  }
  const schema: GraphQLSchema = buildSchema(readFileSync(options.schemaPath, 'utf8'));
  const rootValue = resolversFor(options);
  const requests: RecordedRequest[] = [];

  // A root field the schema has but this server does not answer is an error, never null data.
  const fieldResolver: typeof defaultFieldResolver = (source, args, context, info) => {
    const isRoot = info.parentType === schema.getQueryType() || info.parentType === schema.getMutationType();
    if (isRoot && typeof (source as Record<string, unknown>)[info.fieldName] !== 'function') {
      throw new GraphQLError(`fake data server does not answer ${info.fieldName}`, { extensions: { code: 'NOT_IMPLEMENTED' } });
    }
    return defaultFieldResolver(source, args, context, info);
  };

  const server: Server = createServer(async (req, res) => {
    const entry = record(req, await readBody(req));
    requests.push(entry);
    const fail = (status: number, code: string, message: string) =>
      sendJson(res, status, { errors: [{ message, extensions: { code } }] });
    if (entry.path !== '/graphql') return fail(404, 'NOT_FOUND', `unknown path ${entry.path}`);
    if (entry.method !== 'POST') return fail(405, 'METHOD_NOT_ALLOWED', `unsupported method ${entry.method}`);
    if (options.apiKey !== undefined && req.headers['x-api-key'] !== options.apiKey) {
      return fail(401, 'UNAUTHENTICATED', 'missing or wrong api key');
    }
    const body = entry.body as { query?: unknown; variables?: Record<string, unknown>; operationName?: string } | null;
    if (!body || typeof body !== 'object' || typeof body.query !== 'string') {
      return fail(400, 'BAD_REQUEST', 'body has no query string');
    }
    let document;
    try {
      document = parse(body.query);
    } catch (err) {
      return fail(400, 'GRAPHQL_PARSE_FAILED', (err as Error).message);
    }
    const invalid = validate(schema, document, [...specifiedRules, queryLimits]);
    const tooComplex = invalid.find((e) => e.extensions?.code === 'QUERY_TOO_COMPLEX');
    if (tooComplex) return fail(400, 'QUERY_TOO_COMPLEX', tooComplex.message);
    if (invalid.length > 0) return fail(400, 'GRAPHQL_VALIDATION_FAILED', invalid.map((e) => e.message).join('; '));
    const result = await execute({
      schema,
      document,
      rootValue,
      variableValues: body.variables,
      operationName: body.operationName,
      fieldResolver,
    });
    const notImplemented = result.errors?.some((e) => e.extensions?.code === 'NOT_IMPLEMENTED');
    sendJson(res, notImplemented ? 501 : 200, JSON.parse(JSON.stringify(result)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    graphqlUrl: `${origin}/graphql`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
