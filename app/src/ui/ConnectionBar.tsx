import { useSignal } from '@preact/signals';
import type { CoachController } from '../app/controller';
import { SimulatedTransport } from '../transport/simulatedTransport';
import { WebBluetoothTransport } from '../transport/webBluetoothTransport';
import { strings } from './strings';

export function ConnectionBar({ controller }: { readonly controller: CoachController }) {
  const error = useSignal<string | null>(null);
  const state = controller.connection.value;
  const status = controller.status.value;
  const t = strings(controller.settings.value.language);

  const run = (action: () => Promise<void>) => () => {
    error.value = null;
    action().catch((e: unknown) => {
      error.value = e instanceof Error ? e.message : String(e);
    });
  };

  return (
    <header class="bar">
      <div class="bar-row">
        <span class={`dot ${state}`} aria-hidden="true" />
        <span class="bar-title">
          {state === 'connected'
            ? (controller.deviceName.value ?? t.sensor)
            : state === 'connecting'
              ? t.connecting
              : t.notConnected}
        </span>
        {status && <span class="bar-meta">{status.batteryPercent}%</span>}
        {state === 'disconnected' ? (
          <>
            <button
              type="button"
              class="primary"
              onClick={run(() => controller.connect(new WebBluetoothTransport()))}
            >
              {t.connect}
            </button>
            <button type="button" onClick={run(() => controller.connect(new SimulatedTransport()))}>
              {t.demo}
            </button>
          </>
        ) : (
          <button type="button" onClick={run(() => controller.disconnect())}>
            {t.disconnect}
          </button>
        )}
      </div>
      {error.value && (
        <p class="error" role="alert">
          {error.value}
        </p>
      )}
    </header>
  );
}
