import type { CoachController } from '../app/controller';

export function SettingsView({ controller }: { readonly controller: CoachController }) {
  const settings = controller.settings.value;
  const connected = controller.connection.value === 'connected';
  const step = controller.calibrationStep.value;
  const calibration = controller.calibration.value;

  return (
    <section class="settings">
      <h2>Calibration</h2>
      <p class="hint">
        {calibration
          ? `Calibrated ${new Date(calibration.createdAt).toLocaleDateString()}. Repeat after moving the sensor.`
          : 'Needed once per sensor position. Takes 10 seconds.'}
      </p>
      <ol class="steps">
        <li>
          Lay the racket flat with the face you hit <b>forehands</b> with facing up. Keep still.
          <button
            type="button"
            disabled={!connected || step.step === 'capturing'}
            onClick={() => {
              void controller.capturePose('faceUp');
            }}
          >
            Capture
          </button>
        </li>
        <li>
          Stand the racket on its butt cap, tip up. Keep still.
          <button
            type="button"
            disabled={!connected || step.step !== 'awaitTipUp'}
            onClick={() => {
              void controller.capturePose('tipUp');
            }}
          >
            Capture
          </button>
        </li>
      </ol>
      <p class="status" role="status">
        {step.step === 'capturing' && 'Hold still…'}
        {step.step === 'awaitTipUp' && 'Step 1 done. Now step 2.'}
        {step.step === 'done' && 'Calibration saved.'}
        {step.step === 'failed' && <span class="error">{step.reason}</span>}
      </p>

      <h2>Feedback</h2>
      <fieldset class="field">
        <legend>Mode</legend>
        {(['drill', 'rally'] as const).map((mode) => (
          <label key={mode}>
            <input
              type="radio"
              name="mode"
              checked={settings.mode === mode}
              onChange={() => {
                void controller.updateSettings({ mode });
              }}
            />
            {mode === 'drill'
              ? 'Drill — spoken cue after every stroke'
              : 'Rally — silent, review later'}
          </label>
        ))}
      </fieldset>
      <label class="field">
        <input
          type="checkbox"
          checked={settings.speakGood}
          onChange={(e) => {
            void controller.updateSettings({ speakGood: e.currentTarget.checked });
          }}
        />
        Say “Good” when there is nothing to fix
      </label>
      <label class="field">
        Speech rate {settings.speechRate.toFixed(1)}×
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={settings.speechRate}
          onChange={(e) => {
            void controller.updateSettings({ speechRate: Number(e.currentTarget.value) });
          }}
        />
      </label>

      <h2>Model</h2>
      <label class="field">
        Swing lever (shoulder to sweet spot) {settings.leverRadiusM.toFixed(2)} m
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.05"
          value={settings.leverRadiusM}
          onChange={(e) => {
            void controller.updateSettings({ leverRadiusM: Number(e.currentTarget.value) });
          }}
        />
      </label>
      <p class="hint">Scales racket speed only. Angles do not depend on it.</p>

      {controller.status.value && (
        <p class="hint">
          Firmware {controller.status.value.firmwareVersion} · protocol v
          {controller.status.value.protocolVersion}
        </p>
      )}
    </section>
  );
}
