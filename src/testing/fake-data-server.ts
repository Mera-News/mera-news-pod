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
  /** The places `placeSearch` finds. Unset or empty: the server says places are not loaded. */
  places?: FakePlace[];
}

/** One place as the server stores it. Only `city` and `countryCode` are required. */
export interface FakePlace {
  city: string;
  countryCode: string;
  region?: string | null;
  population?: number | null;
}

export interface FakeDataServer {
  /** Origin, for example `http://127.0.0.1:41234`. */
  origin: string;
  graphqlUrl: string;
  requests: RecordedRequest[];
  /** Answers the next request for this operation with a server error of `code` (default `INDEX_NOT_READY`), once. */
  failNext(operationName: string, code?: string): void;
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
  // Articles that share a story_key are reports of one story, as the server's clustering groups them.
  clusters: [{ clusterId: `c-${a.story_key ?? a._id}`, confidence: 0.9, stableClusterId: `stable-${a.story_key ?? a._id}` }],
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
    // The public server sends a stored address without its query string.
    source_uri: withoutQuery(full.article_url),
    type: 'article',
    publicationSourceId: `pub-${a._id}`,
    country: full.country_code,
    createdAt: full.pubDate,
    updatedAt: full.pubDate,
  };
};

const withoutQuery = (url: string) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
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
      // The story's size, as the server counts it, unless the article sets its own.
      return found ? [{ maxClusterSize: reportsOf(found).length, ...withDefaults(found, now) }] : [];
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

  /** A plain article with its language and publication, as the country and story pages send it. */
  const withSource = (a: FakeArticle) => {
    const full = withDefaults(a, now);
    return { ...asNewsArticle(a, now), original_language_code: full.language_code, publicationSource: asSource(full.publication_name, full.country_code, now) };
  };
  const reportsOf = (a: FakeArticle) => (a.story_key ? articles.filter((b) => b.story_key === a.story_key) : [a]);
  /** One keyset page of `list` by article id; an unknown `after` is the server's BAD_USER_INPUT. */
  const pageOf = <T extends { _id: string }>(list: T[], first: number, after?: string | null) => {
    let start = 0;
    if (after != null) {
      const at = list.findIndex((a) => a._id === after);
      if (at < 0) throw new GraphQLError('after is not a cursor this server gave out', { extensions: { code: 'BAD_USER_INPUT' } });
      start = at + 1;
    }
    const page = list.slice(start, start + first);
    return { page, pageInfo: { endCursor: page.at(-1)?._id ?? null, hasNextPage: start + page.length < list.length, pageSize: page.length } };
  };

  // Newest first; a missing pubDate is as new as the fake. The sort is stable, so ties keep planted order.
  const newestFirst = (list: FakeArticle[]) =>
    [...list].sort((a, b) => Date.parse(withDefaults(b, now).pubDate) - Date.parse(withDefaults(a, now).pubDate));
  // The real server's id caps; a request over one is refused whole, never cut.
  const tooMany = (ids: string[], max: number) => {
    if (ids.length > max) throw new GraphQLError(`Too many article ids: ${ids.length} exceeds the maximum of ${max}`, { extensions: { code: 'BAD_REQUEST' } });
  };
  const clamp = (n: number | null | undefined, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, n ?? fallback));

  return {
    allCountries: () =>
      [...new Set(articles.flatMap((a) => (a.country_code ? [a.country_code.toUpperCase()] : [])))].sort(),
    searchNews: ({ query, limit }: { query: string; limit?: number | null }) => {
      const words = norm(query).split(' ').filter(Boolean);
      if (words.length === 0) return [];
      const hits = newestFirst(
        articles.filter((a) => {
          const text = `${a.title} ${a.title_en ?? ''}`.toLowerCase();
          return words.every((w) => text.includes(w));
        }),
      ).slice(0, clamp(limit, 10, 1, 25));
      return hits.map((a, i) => {
        const full = withDefaults(a, now);
        return {
          _id: a._id,
          title_en: full.title_en,
          pubDate: full.pubDate,
          publication_name: full.publication_name,
          country_code: full.country_code,
          image_url: null,
          score: 1 - i / (hits.length + 1),
        };
      });
    },
    // The cursor is the offset into the newest-first list; the real server freezes its window, this one has no churn.
    searchNewsPage: ({ query, limit, after }: { query: string; limit?: number | null; after?: string | null }) => {
      const words = norm(query).split(' ').filter(Boolean);
      const found = words.length === 0 ? [] : newestFirst(articles.filter((a) => words.every((w) => `${a.title} ${a.title_en ?? ''}`.toLowerCase().includes(w))));
      const start = after == null ? 0 : Number(after);
      if (!Number.isInteger(start) || start < 0) throw new GraphQLError('after is not a cursor this server gave out', { extensions: { code: 'BAD_USER_INPUT' } });
      const size = clamp(limit, 20, 1, 100);
      const slice = found.slice(start, start + size);
      const next = start + slice.length;
      return {
        hits: slice.map((a, i) => {
          const full = withDefaults(a, now);
          return { _id: a._id, title_en: full.title_en, pubDate: full.pubDate, publication_name: full.publication_name, country_code: full.country_code, image_url: null, score: 1 - (start + i) / (found.length + 1) };
        }),
        nextCursor: next < found.length && next < 2500 ? String(next) : null,
      };
    },
    articlesForCountry: ({ countryCode, first, after }: { countryCode?: string | null; first?: number | null; after?: string | null; order?: string | null }) => {
      const code = countryCode?.toUpperCase() === 'GLOBAL' ? null : countryCode;
      const { page, pageInfo } = pageOf(newestFirst(byCountry(code)), clamp(first, 20, 1, 50), after);
      // A cursor per article: the article's id, which `after` accepts.
      return { articles: page.map(withSource), pageInfo, itemCursors: page.map((a) => a._id) };
    },
    articleIdsForPersona: ({ query }: { query: PersonaQuery }) => ({
      topicResults: query.topics.flatMap((t) => {
        const ids = (topics[norm(t.text)] ?? []).slice(0, t.limit ?? query.limitPerTopic);
        return ids.length === 0
          ? []
          : [
              {
                topicText: t.text,
                articleIds: ids,
                // Reports of one story share its stable id, as on the server.
                matchMeta: ids.map((id) => ({ articleId: id, vectorScore: 0.8, textScore: null, stableClusterId: `stable-${articles.find((a) => a._id === id)?.story_key ?? id}` })),
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
    articlesForTopicsByIds: ({ articleIds }: { articleIds: string[] }) => (tooMany(articleIds, 50), hydrate(articleIds)),
    articlesForStories: ({ articleIds }: { articleIds: string[] }) => (tooMany(articleIds, 50), hydrate(articleIds)),
    // An unknown id is left out, as the server leaves out one whose links are mid-swap.
    clusterMembershipsForArticles: ({ articleIds }: { articleIds: string[] }) =>
      (tooMany(articleIds, 500), articleIds).flatMap((id) => {
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
    // Anchored prefix on the lowercase name, most populous first, nothing under two characters, at most 15.
    placeSearch: ({ query, limit }: { query: string; limit: number }) => {
      const q = norm(query);
      if (q.length < 2) return [];
      return (options.places ?? [])
        .filter((p) => norm(p.city).startsWith(q))
        .sort((a, b) => (b.population ?? 0) - (a.population ?? 0))
        .slice(0, Math.min(limit, 15))
        .map((p) => ({
          _id: `place-${slug(p.city)}-${p.countryCode}`,
          city: p.city,
          countryCode: p.countryCode,
          region: p.region ?? null,
          population: p.population ?? null,
          displayName: [p.city, p.region, p.countryCode].filter(Boolean).join(', '),
          normalized: norm(p.city),
          search_keys: [norm(p.city)],
          latitude: null,
          longitude: null,
        }));
    },
    // Only what the fake knows: its places and its newest article. Clustering and the index never ran.
    newsServerStatus: () => ({
      placesSeeded: (options.places ?? []).length > 0,
      lastArticleAt: articles.length ? articles.map((a) => withDefaults(a, now).pubDate).sort().at(-1) : null,
      lastClusteringAt: null,
      lastTopicLinkAt: null,
      headlineEditionsBuilt: false,
      vectorIndexState: null,
      embeddingModel: null,
    }),
    // One headline per story, led by its first served report, paged by the lead's id.
    topHeadlinesForCountry: ({ countryCode, first, after, windowHours }: { countryCode?: string | null; first: number; after?: string | null; windowHours: number }) => {
      if (!WINDOWS.includes(windowHours)) throw new GraphQLError(`windowHours must be one of ${WINDOWS.join(', ')}`, { extensions: { code: 'BAD_WINDOW' } });
      const code = countryCode?.toUpperCase() === 'GLOBAL' ? null : countryCode;
      const leads = byCountry(code)
        .filter((a) => served.includes(a))
        .filter((a, i, list) => !a.story_key || list.findIndex((b) => b.story_key === a.story_key) === i);
      const { page, pageInfo } = pageOf(leads, clamp(first, 20, 1, 200), after);
      const picked = page.map(withSource);
      return {
        articles: picked,
        headlines: page.map((a, i) => ({ article: picked[i], clusterSize: reportsOf(a).length, cursor: a._id, publisherCount: reportsOf(a).length < 2 ? 0 : new Set(reportsOf(a).map((r) => withDefaults(r, now).publication_name)).size, stableClusterId: `stable-${a.story_key ?? a._id}` })),
        editionBuiltAt: now,
        pageInfo,
      };
    },
    newsClusterForArticle: ({ articleId }: { articleId: string }) => {
      const found = articles.find((a) => a._id === articleId);
      if (!found) return null;
      const reports = reportsOf(found);
      const key = found.story_key ?? found._id;
      return {
        _id: `c-${key}`,
        stableClusterId: `stable-${key}`,
        clusterSize: reports.length,
        topicConfidence: null,
        createdAt: now,
        updatedAt: now,
        articles: ({ first, after }: { first?: number | null; after?: string | null }) => {
          const { page, pageInfo } = pageOf(reports, clamp(first, 50, 1, 50), after);
          return {
            articles: page.map(withSource),
            pageInfo,
          };
        },
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
  const failing = new Map<string, string>();

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
    const failWith = body.operationName ? failing.get(body.operationName) : undefined;
    if (failWith) {
      failing.delete(body.operationName!);
      return sendJson(res, 200, { data: null, errors: [{ message: 'the server could not answer', extensions: { code: failWith } }] });
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
    failNext: (operationName, code = 'INDEX_NOT_READY') => void failing.set(operationName, code),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
