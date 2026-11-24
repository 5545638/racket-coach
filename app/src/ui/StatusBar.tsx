import { useSignal } from '@preact/signals';
import type { ComponentChildren } from 'preact';
import type { CoachController } from '../app/controller';
import { strings } from './strings';
import { type StatusBarModel, statusBarModel } from './trainingViewModel';
import './training.css';

/** The optional mute control of the speech branch; absent in older builds. */
function muteControl(controller: CoachController): {
  readonly muted: boolean;
  readonly toggle: () => void;
} | null {
  if (!('toggleMute' in controller) || typeof controller.toggleMute !== 'function') return null;
  const toggle = controller.toggleMute.bind(controller) as () => void;
  const signalLike = (controller as unknown as { speechMuted?: { value: boolean } }).speechMuted;
  return { muted: signalLike?.value ?? false, toggle };
}

function BatteryIcon({ model }: { readonly model: NonNullable<StatusBarModel['battery']> }) {
  return (
    <svg class="sb-battery-icon" viewBox="0 0 28 14" aria-hidden="true">
      <rect x="0.75" y="0.75" width="23" height="12.5" rx="3" class="sb-battery-body" />
      <rect x="25" y="4" width="2.5" height="6" rx="1" class="sb-battery-cap" />
      <rect
        x="2.5"
        y="2.5"
        width={Math.max(1.5, 19.5 * model.fill)}
        height="9"
        rx="1.5"
        class="sb-battery-fill"
      />
    </svg>
  );
}

function SpeakerIcon({ muted }: { readonly muted: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" class="sb-speaker">
      <path d="M3 9.5h4l5-4v13l-5-4H3z" fill="currentColor" />
      {muted ? (
        <path
          d="M16 9.5l5 5m0-5l-5 5"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          fill="none"
        />
      ) : (
        <path
          d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          fill="none"
        />
      )}
    </svg>
  );
}

export function StatusBar({
  controller,
  children,
}: {
  readonly controller: CoachController;
  readonly children?: ComponentChildren;
}) {
  const open = useSignal(false);
  const language = controller.settings.value.language;
  const t = strings(language);
  const mute = muteControl(controller);
  const model = statusBarModel({
    deviceName: controller.deviceName.value,
    fallbackName: t.sensor,
    batteryPercent: controller.status.value?.batteryPercent ?? null,
    mode: controller.settings.value.mode,
    muted: mute ? mute.muted : undefined,
    language,
  });

  return (
    <div class="statusbar">
      <span class="dot connected" aria-hidden="true" />
      <span class="sb-name">{model.deviceName}</span>
      {model.battery && (
        <span
          class={`sb-battery ${model.battery.level}`}
          role="img"
          aria-label={model.battery.aria}
        >
          <BatteryIcon model={model.battery} />
          <span class="sb-battery-text">{model.battery.text}</span>
        </span>
      )}
      <span class="sb-spacer" />
      <div class="sb-mode">
        <button
          type="button"
          class="sb-chip"
          aria-haspopup="true"
          aria-expanded={open.value}
          aria-label={`${model.modePickLabel}: ${model.modeLabel}`}
          onClick={() => {
            open.value = !open.value;
          }}
        >
          {model.modeLabel}
          <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2 4l4 4 4-4" stroke="currentColor" stroke-width="1.8" fill="none" />
          </svg>
        </button>
        {open.value && (
          <div class="sb-menu" role="group" aria-label={model.modePickLabel}>
            {model.modes.map((m) => (
              <button
                key={m.id}
                type="button"
                class={m.selected ? 'sb-option selected' : 'sb-option'}
                aria-pressed={m.selected}
                onClick={() => {
                  open.value = false;
                  void controller.updateSettings({ mode: m.id });
                }}
              >
                {m.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {model.mute && mute && (
        <button
          type="button"
          class={model.mute.muted ? 'sb-icon-btn muted' : 'sb-icon-btn'}
          aria-pressed={model.mute.muted}
          aria-label={model.mute.label}
          onClick={mute.toggle}
        >
          <SpeakerIcon muted={model.mute.muted} />
        </button>
      )}
      {children}
    </div>
  );
}
