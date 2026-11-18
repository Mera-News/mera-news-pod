// The first start makes the one local reader the client expects: a finished, cloud-mode profile
// with no phone-style settings. Every later start finds it and does nothing.
import type { LoadedConfig } from './config';

type Settings = { getSetting(key: string): Promise<string | null>; setSetting(key: string, value: string): Promise<void> };
type Graphql = {
  ProcessingMode: { Cloud: string };
  OnboardingStage: { Finished: string };
};

const WEB_SEARCH_KEY = 'mera_web_search_in_chat';
const WEB_SEARCH_MARKER = 'mera_web_search_forced_on_v1';

export async function seedOnce(cfg: LoadedConfig): Promise<boolean> {
  const { getSetting, setSetting } = require('mera-news-client/dist/lib/database/services/setting-service') as Settings;
  if ((await getSetting('cached_user_id')) !== null) return false;

  const { persistUserPersona } = require('mera-news-client/dist/lib/database/services/user-persona-service') as {
    persistUserPersona(userId: string, persona: Record<string, unknown>): Promise<void>;
  };
  const { ProcessingMode, OnboardingStage } = require('mera-news-client/dist/lib/generated/graphql-types') as Graphql;
  const { useMeraProtocolStore } = require('mera-news-client/dist/lib/stores/mera-protocol-store') as {
    useMeraProtocolStore: { getState(): { setWebSearchInChat(on: boolean): void } };
  };
  const { useAppLanguageStore } = require('mera-news-client/dist/lib/stores/app-language-store') as {
    useAppLanguageStore: { getState(): { setAppLanguage(lang: string): Promise<void> } };
  };

  const language = cfg.language ?? new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language;
  const now = new Date().toISOString();
  await persistUserPersona('local', {
    _id: 'local',
    userId: 'local',
    processingMode: ProcessingMode.Cloud,
    onboardingStage: OnboardingStage.Finished,
    blockedByLlm: false,
    llmWarningCount: 0,
    notificationsEnabled: false,
    preferredNotificationWindow: null,
    language_codes: [language],
    createdAt: now,
    updatedAt: now,
  });
  // The store setter writes its row without waiting, so the row is also written here, awaited. The
  // client's first hydrate deletes an explicit 'false' and turns the option on unless its one-time
  // marker is already there, so the marker is written too.
  // shortcut: the marker's name is the client's own, upgrade when the client exposes a way to seed the option.
  useMeraProtocolStore.getState().setWebSearchInChat(false);
  await setSetting(WEB_SEARCH_KEY, 'false');
  await setSetting(WEB_SEARCH_MARKER, 'true');
  await useAppLanguageStore.getState().setAppLanguage(language);
  // Written last: its presence is what marks the seed as complete, so a crash above repeats it.
  await setSetting('cached_user_id', 'local');
  return true;
}
