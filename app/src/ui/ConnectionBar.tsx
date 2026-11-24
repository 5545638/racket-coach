import { useSignal } from '@preact/signals';
import type { CoachController } from '../app/controller';
import { SimulatedTransport } from '../transport/simulatedTransport';
import { WebBluetoothTransport } from '../transport/webBluetoothTransport';
import { StatusBar } from './StatusBar';
import { strings } from './strings';
import './training.css';

export function ConnectionBar({ controller }: { readonly controller: CoachController }) {
  const error = useSignal<string | null>(null);
  const state = controller.connection.value;
  const t = strings(controller.settings.value.language);

  const run = (action: () => Promise<void>) => () => {
    error.value = null;
    action().catch((e: unknown) => {
      error.value = e instanceof Error ? e.message : String(e);
    });
  };

  const connected = state === 'connected';

  return (
    <header class={connected ? 'bar bar-live' : 'bar'}>
      {connected ? (
        <StatusBar controller={controller}>
          <button
            type="button"
            class="sb-icon-btn"
            aria-label={t.disconnect}
            title={t.disconnect}
            onClick={run(() => controller.disconnect())}
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M12 3v8M6.5 6.5a8 8 0 1011 0"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                fill="none"
              />
            </svg>
          </button>
        </StatusBar>
      ) : (
        <div class="bar-row bar-offline">
          <span class="bar-state">
            <span class={`dot ${state}`} aria-hidden="true" />
            <span class="bar-title">{state === 'connecting' ? t.connecting : t.notConnected}</span>
          </span>
          {state === 'disconnected' && (
            <span class="bar-actions">
              <button
                type="button"
                class="primary big"
                onClick={run(() => controller.connect(new WebBluetoothTransport()))}
              >
                {t.connect}
              </button>
              <button
                type="button"
                class="big"
                onClick={run(() => controller.connect(new SimulatedTransport()))}
              >
                {t.demo}
              </button>
            </span>
          )}
        </div>
      )}
      {error.value && (
        <p class="error" role="alert">
          {error.value}
        </p>
      )}
    </header>
  );
}
