// The client modules the services load, each as a literal require: a bundler follows only literal
// paths. Each loads on first use, after boot has registered the host.
const MODULES = {
  'algorithms/representative-compare': () => require('mera-news-client/dist/lib/algorithms/representative-compare'),
  'article-service': () => require('mera-news-client/dist/lib/article-service'),
  'chat-tools/fact-commit': () => require('mera-news-client/dist/lib/chat-tools/fact-commit'),
  'chat-tools/tool-handlers': () => require('mera-news-client/dist/lib/chat-tools/tool-handlers'),
  'database/index': () => require('mera-news-client/dist/lib/database/index'),
  'database/schema': () => require('mera-news-client/dist/lib/database/schema'),
  'database/services/article-suggestion-persist': () => require('mera-news-client/dist/lib/database/services/article-suggestion-persist'),
  'database/services/article-suggestion-reads': () => require('mera-news-client/dist/lib/database/services/article-suggestion-reads'),
  'database/services/article-suggestion-scoring-writes': () => require('mera-news-client/dist/lib/database/services/article-suggestion-scoring-writes'),
  'database/services/fact-service': () => require('mera-news-client/dist/lib/database/services/fact-service'),
  'database/services/publication-pref-ui-actions': () => require('mera-news-client/dist/lib/database/services/publication-pref-ui-actions'),
  'database/services/topic-decline-service': () => require('mera-news-client/dist/lib/database/services/topic-decline-service'),
  'database/services/topic-generation-status-service': () => require('mera-news-client/dist/lib/database/services/topic-generation-status-service'),
  'database/services/topic-service': () => require('mera-news-client/dist/lib/database/services/topic-service'),
  'database/services/tracked-story-service': () => require('mera-news-client/dist/lib/database/services/tracked-story-service'),
  'mera-harness/core/combined-fact': () => require('mera-news-client/dist/lib/mera-harness/core/combined-fact'),
  'mera-harness/core/fact-normalise': () => require('mera-news-client/dist/lib/mera-harness/core/fact-normalise'),
  'news-harness/core/config': () => require('mera-news-client/dist/lib/news-harness/core/config'),
  'news-harness/feed-select/ownership': () => require('mera-news-client/dist/lib/news-harness/feed-select/ownership'),
  'news-harness/persona-management/fact-conflict': () => require('mera-news-client/dist/lib/news-harness/persona-management/fact-conflict'),
  'news-harness/persona-management/fact-rules': () => require('mera-news-client/dist/lib/news-harness/persona-management/fact-rules'),
  'scheduler/AppScheduler': () => require('mera-news-client/dist/lib/scheduler/AppScheduler'),
  'scheduler/scheduler-store': () => require('mera-news-client/dist/lib/scheduler/scheduler-store'),
  'stores/feed-list-selector': () => require('mera-news-client/dist/lib/stores/feed-list-selector'),
  'stores/mera-protocol-store': () => require('mera-news-client/dist/lib/stores/mera-protocol-store'),
  'sync/command': () => require('mera-news-client/dist/lib/sync/command'),
  'sync/commands': () => require('mera-news-client/dist/lib/sync/commands'),
  'sync/snapshot': () => require('mera-news-client/dist/lib/sync/snapshot'),
  'sync/tables': () => require('mera-news-client/dist/lib/sync/tables'),
  'tracking/story-fold-key': () => require('mera-news-client/dist/lib/tracking/story-fold-key'),
  'tracking/track-actions': () => require('mera-news-client/dist/lib/tracking/track-actions'),
  'user-context/user-geo-language-context': () => require('mera-news-client/dist/lib/user-context/user-geo-language-context'),
} satisfies Record<string, () => unknown>;

export type ClientModule = keyof typeof MODULES;

export const client = <T>(file: ClientModule) => MODULES[file]() as T;
