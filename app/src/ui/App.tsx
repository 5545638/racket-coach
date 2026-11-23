import { useSignal } from '@preact/signals';
import type { CoachController } from '../app/controller';
import { ConnectionBar } from './ConnectionBar';
import { LiveView } from './LiveView';
import { SessionView } from './SessionView';
import { SettingsView } from './SettingsView';

type Tab = 'live' | 'session' | 'settings';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'live', label: 'Live' },
  { id: 'session', label: 'Session' },
  { id: 'settings', label: 'Setup' },
];

export function App({ controller }: { readonly controller: CoachController }) {
  const tab = useSignal<Tab>(controller.calibration.value ? 'live' : 'settings');

  return (
    <div class="app">
      <ConnectionBar controller={controller} />
      <main class="content">
        {tab.value === 'live' && <LiveView controller={controller} />}
        {tab.value === 'session' && <SessionView controller={controller} />}
        {tab.value === 'settings' && <SettingsView controller={controller} />}
      </main>
      <nav class="tabs" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            class={tab.value === t.id ? 'tab active' : 'tab'}
            aria-current={tab.value === t.id ? 'page' : undefined}
            onClick={() => {
              tab.value = t.id;
            }}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
