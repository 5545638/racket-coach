import type { CoachController } from '../app/controller';
import { DEFAULT_ASSESS_CONFIG } from '../elements/assess';
import { DEFAULT_BASELINE_CONFIG } from '../coach/baseline';
import { strings } from './strings';

export function SettingsView({ controller }: { readonly controller: CoachController }) {
  const settings = controller.settings.value;
  const t = strings(settings.language);
  const connected = controller.connection.value === 'connected';
  const step = controller.calibrationStep.value;
  const calibration = controller.calibration.value;
  const status = controller.status.value;

  return (
    <section class="settings">
      <h2>{t.setup.calibration}</h2>
      <p class="hint">
        {calibration
          ? t.setup.calibrated(new Date(calibration.createdAt).toLocaleDateString())
          : t.setup.calibrationNeeded}
      </p>
      <ol class="steps">
        <li>
          {t.setup.stepFaceUp}
          <button
            type="button"
            disabled={!connected || step.step === 'capturing'}
            onClick={() => {
              void controller.capturePose('faceUp');
            }}
          >
            {t.setup.capture}
          </button>
        </li>
        <li>
          {t.setup.stepTipUp}
          <button
            type="button"
            disabled={!connected || step.step !== 'awaitTipUp'}
            onClick={() => {
              void controller.capturePose('tipUp');
            }}
          >
            {t.setup.capture}
          </button>
        </li>
      </ol>
      <p class="status" role="status">
        {step.step === 'capturing' && t.setup.holdStill}
        {step.step === 'awaitTipUp' && t.setup.step1Done}
        {step.step === 'done' && t.setup.saved}
        {step.step === 'failed' && <span class="error">{step.reason}</span>}
      </p>

      <h2>{t.setup.feedback}</h2>
      <fieldset class="field">
        <legend>{t.setup.mode}</legend>
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
            {mode === 'drill' ? t.setup.drillMode : t.setup.rallyMode}
          </label>
        ))}
      </fieldset>
      <fieldset class="field">
        <legend>{t.setup.language}</legend>
        {(['et', 'en'] as const).map((language) => (
          <label key={language}>
            <input
              type="radio"
              name="language"
              checked={settings.language === language}
              onChange={() => {
                void controller.updateSettings({ language });
              }}
            />
            {language === 'et' ? 'Eesti' : 'English'}
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
        {t.setup.speakGood}
      </label>
      <label class="field">
        {t.setup.speechRate} {settings.speechRate.toFixed(1)}×
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

      <h2>{t.setup.model}</h2>
      <label class="field">
        {t.setup.lever} {settings.leverRadiusM.toFixed(2)} m
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.01"
          value={settings.leverRadiusM}
          onChange={(e) => {
            void controller.updateSettings({ leverRadiusM: Number(e.currentTarget.value) });
          }}
        />
      </label>
      <p class="hint">{t.setup.leverHint}</p>

      <h2>{t.setup.engine}</h2>
      <p class="hint">{t.setup.confidenceInfo(Math.round(DEFAULT_ASSESS_CONFIG.pMin * 100))}</p>
      <h3>{t.setup.baseline}</h3>
      <p class="hint">{t.setup.baselineInfo(DEFAULT_BASELINE_CONFIG.minStrokes)}</p>
      <ul class="baseline-counts">
        {(['forehand', 'backhand', 'overhead'] as const).map((type) => (
          <li key={type}>
            {controller.baselineLoading.value
              ? `${t.stroke[type]}: ${t.setup.baselineLoading}`
              : t.setup.baselineCount(
                  t.stroke[type],
                  controller.baselineCounts.value[type],
                  DEFAULT_BASELINE_CONFIG.minStrokes,
                )}
          </li>
        ))}
      </ul>
      <div class="actions">
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t.setup.resetConfirm)) void controller.resetBaseline();
          }}
        >
          {t.setup.resetBaseline}
        </button>
      </div>
      {settings.baselineResetAt > 0 && (
        <p class="hint">{t.setup.resetDone(new Date(settings.baselineResetAt).toLocaleString())}</p>
      )}

      {status && (
        <p class="hint">
          {t.setup.firmware} {status.firmwareVersion} · {t.setup.protocol} v{status.protocolVersion}
        </p>
      )}
    </section>
  );
}
