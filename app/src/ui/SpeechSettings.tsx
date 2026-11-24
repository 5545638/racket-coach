import { useEffect } from 'preact/hooks';
import { type CoachController, countOf } from '../app/controller';
import type { FeedbackFrequency, SpokenLanguage, VoiceSettings } from '../domain/types';
import { voicesFor } from '../feedback/speech';
import { speechStrings } from '../feedback/speechStrings';
import './speech.css';

const FREQUENCIES: readonly FeedbackFrequency[] = ['every', 'changes', 'every2', 'every3', 'off'];

const withoutVoiceURI = ({ lang, rate, pitch, volume }: VoiceSettings): VoiceSettings => ({
  lang,
  rate,
  pitch,
  volume,
});

/** Speech settings: mute, frequency, rally mute, language, voice profile, test, diagnostics. */
export function SpeechSettings({ controller }: { readonly controller: CoachController }) {
  const settings = controller.settings.value;
  const t = speechStrings(settings.language);
  const voice = settings.voice;
  const voices = voicesFor(controller.voices.value, voice.lang);
  const stats = controller.speechStats.value;

  useEffect(() => {
    controller.refreshVoices();
  }, [controller]);

  const setVoice = (patch: Partial<VoiceSettings>): void => {
    void controller.updateSettings({ voice: { ...voice, ...patch } });
  };
  const setLanguage = (lang: SpokenLanguage): void => {
    // A voice belongs to one language: the choice does not carry over.
    void controller.updateSettings({ voice: { ...withoutVoiceURI(voice), lang } });
  };

  return (
    <div class="speech-settings">
      <h3>{t.heading}</h3>
      <label class="field">
        <input
          type="checkbox"
          checked={settings.speechMuted}
          onChange={() => {
            void controller.toggleMute();
          }}
        />
        {t.mute}
      </label>
      <p class="hint">{t.muteHint}</p>

      <fieldset class="field">
        <legend>{t.frequency}</legend>
        {FREQUENCIES.map((frequency) => (
          <label key={frequency}>
            <input
              type="radio"
              name="feedbackFrequency"
              checked={settings.feedbackFrequency === frequency}
              onChange={() => {
                void controller.updateSettings({ feedbackFrequency: frequency });
              }}
            />
            {t.frequencyOption[frequency]}
          </label>
        ))}
      </fieldset>

      <label class="field">
        <input
          type="checkbox"
          checked={settings.autoRallyMute}
          onChange={(e) => {
            void controller.updateSettings({ autoRallyMute: e.currentTarget.checked });
          }}
        />
        {t.autoRally}
      </label>
      <p class="hint">{t.autoRallyHint}</p>
      {settings.autoRallyMute && controller.rallyActive.value && (
        <p class="hint" role="status">
          {t.rallyNow}
        </p>
      )}

      <fieldset class="field">
        <legend>{t.spokenLanguage}</legend>
        {(['et', 'en'] as const).map((lang) => (
          <label key={lang}>
            <input
              type="radio"
              name="spokenLanguage"
              checked={voice.lang === lang}
              onChange={() => {
                setLanguage(lang);
              }}
            />
            {t.languageName[lang]}
          </label>
        ))}
      </fieldset>
      {controller.estonianVoiceMissing.value && (
        <p class="hint warning" role="status">
          {t.noEstonianVoice}
        </p>
      )}

      <label class="field">
        {t.voice}
        {voices.length > 0 ? (
          <select
            class="speech-voice"
            value={voice.voiceURI ?? ''}
            onChange={(e) => {
              const uri = e.currentTarget.value;
              if (uri === '') {
                void controller.updateSettings({ voice: withoutVoiceURI(voice) });
              } else {
                setVoice({ voiceURI: uri });
              }
            }}
          >
            <option value="">{t.defaultVoice}</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        ) : (
          <span class="hint"> {t.noVoices}</span>
        )}
      </label>

      <label class="field">
        {t.rate} {voice.rate.toFixed(1)}×
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={voice.rate}
          onChange={(e) => {
            setVoice({ rate: Number(e.currentTarget.value) });
          }}
        />
      </label>
      <label class="field">
        {t.pitch} {voice.pitch.toFixed(1)}
        <input
          type="range"
          min="0.5"
          max="2"
          step="0.1"
          value={voice.pitch}
          onChange={(e) => {
            setVoice({ pitch: Number(e.currentTarget.value) });
          }}
        />
      </label>
      <label class="field">
        {t.volume} {Math.round(voice.volume * 100)}%
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={voice.volume}
          onChange={(e) => {
            setVoice({ volume: Number(e.currentTarget.value) });
          }}
        />
      </label>
      <div class="actions">
        <button
          type="button"
          onClick={() => {
            controller.testSpeech();
          }}
        >
          {t.test}
        </button>
      </div>

      <h3>{t.diagnostics}</h3>
      <p class="hint">
        {stats.p50Ms !== null && stats.p95Ms !== null
          ? t.latency(Math.round(stats.p50Ms), Math.round(stats.p95Ms), stats.latenciesMs.length)
          : t.noLatency}
      </p>
      <p class="hint">
        {t.dropped(countOf(stats.dropped))} · {t.suppressed(countOf(stats.suppressed))}
      </p>
    </div>
  );
}
