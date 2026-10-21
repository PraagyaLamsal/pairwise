import { useEffect, useState } from 'react';
import { DEFAULT_MODELS, VOICES } from '@shared/app-info';
import type { ApiKeyStatus, RunningApp } from '@shared/ipc';
import { SHORTCUTS, findConflicts, type ShortcutAction } from '@shared/shortcuts';
import type { Settings } from '@shared/settings';
import { Icon } from '../../ui/icons';
import { ipc } from '../../ui/ipc';
import { useSettings } from '../../ui/hooks';
import { Button, Group, Kbd, Modal, Row, Segmented, Select, Spinner, TextField, Toggle } from '../../ui/kit';

type Section = 'tutor' | 'look' | 'shortcuts' | 'privacy' | 'takeover' | 'models';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'tutor', label: 'Tutor' },
  { id: 'look', label: 'Cursor & ink' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'takeover', label: 'Takeover' },
  { id: 'models', label: 'Gemini' },
];

export function SettingsPage() {
  const [s, update] = useSettings();
  const [section, setSection] = useState<Section>('tutor');
  // A saved key this build can't read: start where it can be pasted again.
  useEffect(() => {
    void ipc.invoke('secrets:status').then((k) => k.unreadable && setSection('models'));
  }, []);
  if (!s) return null;
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
        </div>
        <Segmented value={section} options={SECTIONS.map((x) => ({ value: x.id, label: x.label }))} onChange={setSection} />
      </div>
      {section === 'tutor' && <TutorSection s={s} update={update} />}
      {section === 'look' && <LookSection s={s} update={update} />}
      {section === 'shortcuts' && <ShortcutsSection s={s} update={update} />}
      {section === 'privacy' && <PrivacySection s={s} update={update} />}
      {section === 'takeover' && <TakeoverSection s={s} update={update} />}
      {section === 'models' && <ModelsSection s={s} update={update} />}
    </div>
  );
}

type SectionProps = { s: Settings; update: (p: Parameters<ReturnType<typeof useSettings>[1]>[0]) => Promise<void> };

function TutorSection({ s, update }: SectionProps) {
  const [name, setName] = useState(s.tutorName);
  return (
    <>
      <Group title="Voice">
        <Row title="Tutor's name" help="Shown on its cursor and used when it talks about itself.">
          <TextField value={name} onChange={setName} width={160} onEnter={() => void update({ tutorName: name.trim() || 'Ada' })} />
          {name !== s.tutorName && (
            <Button size="s" onClick={() => void update({ tutorName: name.trim() || 'Ada' })}>
              Save
            </Button>
          )}
        </Row>
        <Row title="Voice">
          <Select value={s.voice} onChange={(voice) => void update({ voice })} options={VOICES.map((v) => ({ value: v.name, label: `${v.name} — ${v.vibe}` }))} width={200} />
        </Row>
        <Row title="Speaking speed" help="Asks the tutor to pace itself, and fine-tunes playback without changing pitch.">
          <Segmented
            value={s.speakingSpeed}
            options={[
              { value: 'slower', label: 'Slower' },
              { value: 'normal', label: 'Normal' },
              { value: 'faster', label: 'Faster' },
            ]}
            onChange={(speakingSpeed) => void update({ speakingSpeed, playbackRate: speakingSpeed === 'slower' ? 0.9 : speakingSpeed === 'faster' ? 1.15 : 1 })}
          />
        </Row>
        <Row title="Explanation depth" help="Brief answers, step-by-step, or the full reasoning with examples.">
          <Segmented
            value={s.explanationDepth}
            options={[
              { value: 'brief', label: 'Brief' },
              { value: 'standard', label: 'Standard' },
              { value: 'deep', label: 'Deep' },
            ]}
            onChange={(explanationDepth) => void update({ explanationDepth })}
          />
        </Row>
        <Row title="Quick checks" help={`Now and then ${s.tutorName} asks you to click the answer on your screen ("show me where the loop ends"), to check you've got it.`}>
          <Segmented
            value={s.quickChecks}
            options={[
              { value: 'often', label: 'Often' },
              { value: 'sometimes', label: 'Sometimes' },
              { value: 'off', label: 'Off' },
            ]}
            onChange={(quickChecks) => void update({ quickChecks })}
          />
        </Row>
      </Group>
      <Group title="Conversation">
        <Row title="Talk mode" help="Hands-free listens all the time and lets you interrupt. Hold-to-talk only listens while you hold the ask keys.">
          <Segmented
            value={s.talkMode}
            options={[
              { value: 'hands-free', label: 'Hands-free' },
              { value: 'push-to-talk', label: 'Hold to talk' },
            ]}
            onChange={(talkMode) => void update({ talkMode })}
          />
        </Row>
        <Row title="Live captions" help="Shows what you and the tutor say under the session bar.">
          <Toggle checked={s.captions} onChange={(captions) => void update({ captions })} />
        </Row>
        <Row title="Auto-pause media" help="Pauses the lecture video or music when you start talking or drawing; resume it from the session bar.">
          <Select
            value={s.autoPauseMedia}
            onChange={(autoPauseMedia) => void update({ autoPauseMedia })}
            options={[
              { value: 'smart', label: 'Players + browser video' },
              { value: 'media-key', label: 'Browser video only' },
              { value: 'off', label: 'Off' },
            ]}
            width={210}
          />
        </Row>
        <Row title="Celebrate wins" help="A small burst of confetti when you get something right.">
          <Toggle checked={s.celebrate} onChange={(celebrate) => void update({ celebrate })} />
        </Row>
        <Row title="Sounds" help="Soft chimes for start, end and handing over control.">
          <Toggle checked={s.sounds} onChange={(sounds) => void update({ sounds })} />
        </Row>
      </Group>
      <Group title="Session notes">
        <Row title="Save notes after each session" help="A summary, key diagrams and things to review, saved into the course folder.">
          <Toggle checked={s.notes.enabled} onChange={(enabled) => void update({ notes: { enabled } })} />
        </Row>
        <Row title="Include the transcript">
          <Toggle checked={s.notes.includeTranscript} onChange={(includeTranscript) => void update({ notes: { includeTranscript } })} />
        </Row>
        <Row title="Tell me when they're saved" help="A notification when the notes are ready, a moment after the session ends. Click it to open them.">
          <Toggle checked={s.notes.notify} onChange={(notify) => void update({ notes: { notify } })} />
        </Row>
      </Group>
    </>
  );
}

function LookSection({ s, update }: SectionProps) {
  return (
    <>
      <Group title="Cursor">
        <Row title="Tutor's ink color" help="The cursor, its arrows and circles.">
          <input className="color-input" type="color" value={s.tutorColor} onChange={(e) => void update({ tutorColor: e.target.value })} />
        </Row>
        <Row title="Your ink color" help="What you draw while asking.">
          <input className="color-input" type="color" value={s.studentInkColor} onChange={(e) => void update({ studentInkColor: e.target.value })} />
        </Row>
        <Row title={`${s.tutorName} writes notes`} help="Typed in the system font, like Tuple's text tool — or in handwriting.">
          <Segmented
            value={s.noteStyle}
            options={[
              { value: 'typed', label: 'Typed (like Tuple)' },
              { value: 'handwritten', label: 'Handwritten' },
            ]}
            onChange={(noteStyle) => void update({ noteStyle })}
          />
        </Row>
      </Group>
      <Group title="Drawings">
        <Row title="Clear the tutor's drawings" help="After it finishes talking, or only when you clear them.">
          <Segmented
            value={s.inkFade}
            options={[
              { value: 'after-speech', label: 'After it talks' },
              { value: 'manual', label: 'When I clear' },
            ]}
            onChange={(inkFade) => void update({ inkFade })}
          />
          {s.inkFade === 'after-speech' && (
            <Select
              value={String(s.inkFadeDelaySec)}
              onChange={(v) => void update({ inkFadeDelaySec: Number(v) })}
              options={[3, 6, 10, 20].map((n) => ({ value: String(n), label: `${n} s later` }))}
              width={110}
            />
          )}
        </Row>
        <Row title="Keep drawings with what they mark" help="Scroll and they move with the page; switch to another app and they clear.">
          <Toggle checked={s.stickyInk} onChange={(stickyInk) => void update({ stickyInk })} />
        </Row>
        <Row title="Preview" help="Draws a short demo of the cursor and annotations on your screen.">
          <Button size="s" icon="sparkle" onClick={() => void ipc.invoke('diagnostics:previewInk')}>
            Preview on screen
          </Button>
        </Row>
      </Group>
    </>
  );
}

function ShortcutsSection({ s, update }: SectionProps) {
  const conflicts = findConflicts(s.shortcuts);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  useEffect(() => {
    if (!recording) return;
    const spec = SHORTCUTS.find((x) => x.action === recording);
    const held = new Set<string>();
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.key === 'Escape') {
        setRecording(null);
        return;
      }
      const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean) as string[];
      const isMod = ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
      if (e.type === 'keydown') {
        if (isMod) {
          held.add(e.key);
          return;
        }
        if (spec?.kind === 'hold') return; // hold shortcuts are modifier-only chords
        if (!mods.length) return; // require at least one modifier for global shortcuts
        const key = e.code.startsWith('Key') ? e.code.slice(3) : e.code.startsWith('Digit') ? e.code.slice(5) : e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key;
        void update({ shortcuts: { [recording]: [...mods, key].join('+') } as Record<ShortcutAction, string> });
        setRecording(null);
      } else if (e.type === 'keyup' && spec?.kind === 'hold' && isMod) {
        // Chord = the modifiers that were down together, captured on first release.
        const names = [...held].map((k) => (k === 'Meta' ? 'Command' : k));
        if (names.length >= 2) {
          void update({ shortcuts: { [recording]: names.join('+') } as Record<ShortcutAction, string> });
          setRecording(null);
        }
        held.clear();
      }
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [recording, update]);

  return (
    <Group
      title="Keyboard shortcuts — work in every app"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Click a shortcut to change it, then press the new keys. Hold shortcuts use modifier keys only (press two together, then release).</span>
          <Button size="s" variant="ghost" icon="refresh" onClick={() => void ipc.invoke('settings:resetShortcuts')}>
            Reset all
          </Button>
        </div>
      }
    >
      {SHORTCUTS.map((sc) => (
        <Row key={sc.action} title={sc.label} help={sc.description}>
          <button className={`recorder ${recording === sc.action ? 'recording' : ''} ${conflicts.includes(sc.action) ? 'conflict' : ''}`} onClick={() => setRecording(recording === sc.action ? null : sc.action)}>
            {recording === sc.action ? (sc.kind === 'hold' ? 'Press two modifier keys…' : 'Press the new shortcut…') : <Kbd accel={s.shortcuts[sc.action]} small />}
          </button>
        </Row>
      ))}
    </Group>
  );
}

function PrivacySection({ s, update }: SectionProps) {
  const [picker, setPicker] = useState(false);
  const [running, setRunning] = useState<RunningApp[]>([]);
  const [custom, setCustom] = useState('');

  const openPicker = async () => {
    setPicker(true);
    setRunning(await ipc.invoke('veil:runningApps').catch(() => []));
  };
  const add = (app: RunningApp) => {
    if (s.veil.apps.some((a) => (a.bundleId && a.bundleId === app.bundleId) || a.name.toLowerCase() === app.name.toLowerCase())) return;
    void update({ veil: { apps: [...s.veil.apps, { name: app.name, bundleId: app.bundleId }] } });
  };
  const remove = (name: string) => void update({ veil: { apps: s.veil.apps.filter((a) => a.name !== name) } });

  return (
    <>
      <Group title="App Veil" footer="Veiled windows are painted black on every frame before it leaves your Mac. They get a dashed orange outline on your screen so you know the tutor can't see them.">
        <div className="veil-list">
          {s.veil.apps.map((a) => (
            <span className="veil-app" key={a.name} title={a.bundleId}>
              <Icon name="lock" size={12} />
              {a.name}
              <button onClick={() => remove(a.name)} aria-label={`Stop veiling ${a.name}`}>
                <Icon name="close" size={10} />
              </button>
            </span>
          ))}
          <Button size="s" variant="ghost" icon="plus" onClick={() => void openPicker()}>
            Add app
          </Button>
        </div>
        <Row title="Hide notification banners">
          <Toggle checked={s.veil.hideNotifications} onChange={(hideNotifications) => void update({ veil: { hideNotifications } })} />
        </Row>
        <Row title="Outline veiled windows on my screen">
          <Toggle checked={s.veil.showOutlines} onChange={(showOutlines) => void update({ veil: { showOutlines } })} />
        </Row>
      </Group>
      <Group title="Screenshots">
        <Row title="Save annotated screenshots in session notes" help="Off by default: nothing from your screen is written to disk. Whiteboard drawings are always saved.">
          <Toggle checked={s.privacy.saveAnnotatedScreenshots} onChange={(saveAnnotatedScreenshots) => void update({ privacy: { saveAnnotatedScreenshots } })} />
        </Row>
      </Group>
      <Modal open={picker} onClose={() => setPicker(false)} title="Veil an app" width={440}>
        <p className="muted" style={{ marginBottom: 10 }}>
          Apps with open windows:
        </p>
        <div className="veil-list" style={{ padding: 0 }}>
          {running.length === 0 && <span className="muted">None found — type a name below.</span>}
          {running.map((a) => (
            <Button key={a.bundleId ?? a.name} size="s" variant="secondary" onClick={() => add(a)}>
              {a.name}
            </Button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <TextField value={custom} onChange={setCustom} placeholder="App name, e.g. Discord" width="100%" onEnter={() => { if (custom.trim()) { add({ name: custom.trim() }); setCustom(''); } }} />
          <Button disabled={!custom.trim()} onClick={() => { add({ name: custom.trim() }); setCustom(''); }}>
            Add
          </Button>
        </div>
      </Modal>
    </>
  );
}

function TakeoverSection({ s, update }: SectionProps) {
  return (
    <Group
      title="Letting the tutor drive"
      footer="The tutor always asks first. While it drives, any mouse movement or Esc hands control straight back. It never sends, submits, deletes or runs anything without you confirming that exact action."
    >
      <Row title="Allow takeover requests">
        <Toggle checked={s.takeover.enabled} onChange={(enabled) => void update({ takeover: { enabled } })} />
      </Row>
      <Row title="Typing speed" help="How fast it types when demonstrating, so you can follow along.">
        <Select
          value={String(s.takeover.typingCharsPerSecond)}
          onChange={(v) => void update({ takeover: { typingCharsPerSecond: Number(v) } })}
          options={[
            { value: '8', label: 'Slow' },
            { value: '18', label: 'Natural' },
            { value: '40', label: 'Fast' },
          ]}
          width={120}
        />
      </Row>
      <Row title="Hand control back after" help="If the tutor goes idle while driving.">
        <Select
          value={String(s.takeover.autoRevokeSec)}
          onChange={(v) => void update({ takeover: { autoRevokeSec: Number(v) } })}
          options={[15, 30, 45, 90].map((n) => ({ value: String(n), label: `${n} seconds` }))}
          width={130}
        />
      </Row>
    </Group>
  );
}

function ModelsSection({ s, update }: SectionProps) {
  const [key, setKey] = useState('');
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    void ipc.invoke('secrets:status').then(setStatus);
  }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const r = await ipc.invoke('secrets:setApiKey', key.trim());
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: 'Key saved.' } : { ok: false, text: r.error ?? 'That key did not work.' });
    if (r.ok) setKey('');
    setStatus(await ipc.invoke('secrets:status'));
  };

  const modelRow = (k: keyof Settings['models'], title: string, help: string) => (
    <Row title={title} help={help}>
      <TextField value={s.models[k]} onChange={(v) => void update({ models: { [k]: v } })} width={250} mono />
      {s.models[k] !== DEFAULT_MODELS[k] && (
        <Button size="s" variant="ghost" icon="refresh" onClick={() => void update({ models: { [k]: DEFAULT_MODELS[k] } })} title="Reset to default" />
      )}
    </Row>
  );

  return (
    <>
      <Group title="API key">
        <Row
          title={status?.hasKey ? `Connected (${status.preview})` : status?.unreadable ? 'Saved key can\'t be read by this copy of Pairwise' : 'No key — the demo tutor is used'}
          help={status?.unreadable ? 'It was saved by another build (for example npm run dev). Paste it again below; until then the demo tutor is used.' : status?.source === 'env' ? 'Using GEMINI_API_KEY from the environment.' : 'Stored encrypted in your keychain.'}
        >
          {status?.source === 'keychain' && (
            <Button size="s" variant="ghost" onClick={() => void ipc.invoke('secrets:clearApiKey').then(setStatus)}>
              Remove
            </Button>
          )}
        </Row>
        <Row title="Replace key">
          <TextField value={key} onChange={setKey} type="password" placeholder="AIza…" width={250} onEnter={() => void save()} mono />
          <Button size="s" variant="primary" disabled={!key.trim() || busy} onClick={() => void save()}>
            {busy ? <Spinner size={11} /> : 'Save'}
          </Button>
        </Row>
        {msg && (
          <div className="row" style={{ color: msg.ok ? '#6ee7b7' : '#ff8a8e' }}>
            {msg.text}
          </div>
        )}
      </Group>
      <Group title="Models" footer="Defaults were checked against Google's model list in October 2026. Change them only if Google renames a model.">
        {modelRow('live', 'Live voice + screen', 'Real-time voice conversation with screen frames.')}
        {modelRow('vision', 'Pointing & reading', 'Finds exactly where things are and reads small text.')}
        {modelRow('reasoning', 'Deep reasoning', 'Plans tricky explanations, proofs and diagrams.')}
        {modelRow('text', 'Notes & course profile', 'Summaries and course terminology.')}
        {modelRow('embedding', 'Course search', 'Embeddings for finding the right slide.')}
        <Row title="Deeper live thinking" help="Uses the extended-thinking live model: smarter, a little slower to start talking.">
          <Toggle checked={s.useDeepLiveModel} onChange={(useDeepLiveModel) => void update({ useDeepLiveModel })} />
        </Row>
        <Row title="Live screen detail" help="Higher detail reads small text better but costs more per frame.">
          <Segmented
            value={s.liveMediaResolution}
            options={[
              { value: 'MEDIA_RESOLUTION_LOW', label: 'Low' },
              { value: 'MEDIA_RESOLUTION_MEDIUM', label: 'Medium' },
              { value: 'MEDIA_RESOLUTION_HIGH', label: 'High' },
            ]}
            onChange={(liveMediaResolution) => void update({ liveMediaResolution })}
          />
        </Row>
      </Group>
    </>
  );
}
