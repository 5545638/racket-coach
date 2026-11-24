import { useSignal } from '@preact/signals';
import { useEffect } from 'preact/hooks';
import type { CoachController } from '../app/controller';
import { ConnectionBar } from './ConnectionBar';
import { LiveView } from './LiveView';
import { SessionView } from './SessionView';
import { SettingsView } from './SettingsView';
import { strings } from './strings';

type Tab = 'live' | 'session' | 'settings';

const TABS: readonly Tab[] = ['live', 'session', 'settings'];

export function App({ controller }: { readonly controller: CoachController }) {
  const tab = useSignal<Tab>('live');
  const language = controller.settings.value.language;
  const t = strings(language);
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const labels: Record<Tab, string> = {
    live: t.tabs.live,
    session: t.tabs.session,
    settings: t.tabs.setup,
  };

  return (
    <div class="app">
      <ConnectionBar controller={controller} />
      <main class="content">
        {tab.value === 'live' && <LiveView controller={controller} />}
        {tab.value === 'session' && <SessionView controller={controller} />}
        {tab.value === 'settings' && <SettingsView controller={controller} />}
      </main>
      <nav class="tabs" aria-label={t.sections}>
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            class={tab.value === id ? 'tab active' : 'tab'}
            aria-current={tab.value === id ? 'page' : undefined}
            onClick={() => {
              tab.value = id;
            }}
          >
            {labels[id]}
          </button>
        ))}
      </nav>
    </div>
  );
}
