import { useEffect, useState } from 'react';
import { APP_NAME } from '@shared/app-info';
import type { ApiKeyStatus } from '@shared/ipc';
import type { PermissionStatus } from '@shared/session';
import { Icon, type IconName } from '../../ui/icons';
import { ipc } from '../../ui/ipc';
import { usePermissions, useSettings } from '../../ui/hooks';
import { Button, Kbd, Pill, Spinner, TextField } from '../../ui/kit';
import { InkRing } from '../../ui/ink';
import { OnboardingArt } from './OnboardingArt';

const STEPS = ['welcome', 'key', 'permissions', 'talk', 'done'] as const;
type Step = (typeof STEPS)[number];

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<Step>('welcome');
  const idx = STEPS.indexOf(step);
  const next = () => setStep(STEPS[Math.min(STEPS.length - 1, idx + 1)]);
  const back = () => setStep(STEPS[Math.max(0, idx - 1)]);
  const finish = async () => {
    await ipc.invoke('onboarding:complete');
    onDone();
  };

  return (
    <div className="onboarding">
      <div className="ob-art">
        <OnboardingArt />
      </div>
      <div className="ob-main">
        <div className="ob-steps" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={i < idx ? 'done' : i === idx ? 'cur' : ''} />
          ))}
        </div>
        {step === 'welcome' && <Welcome />}
        {step === 'key' && <KeyStep />}
        {step === 'permissions' && <PermissionsStep />}
        {step === 'talk' && <TalkStep />}
        {step === 'done' && <DoneStep />}
        <div className="ob-foot">
          {idx > 0 ? (
            <Button variant="ghost" onClick={back}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {step === 'done' ? (
            <Button variant="primary" size="l" onClick={() => void finish()}>
              Go to my courses
            </Button>
          ) : (
            <Button variant="primary" size="l" onClick={next}>
              {step === 'welcome' ? 'Set it up' : 'Continue'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Welcome() {
  return (
    <>
      <h1>A tutor that sits next to you while you work.</h1>
      <p className="lede">
        Start a session and {APP_NAME}'s tutor can see your screen, talk it through with you, point with its own cursor and draw right on top of
        your slides, code or lecture video. It teaches from your course folder, so it uses your professor's terms and examples.
      </p>
      <div className="ob-body">
        <div className="tip">
          <Icon name="eye" size={16} />
          <span>It only sees your screen during a session, and apps you veil (Messages, password managers…) are blacked out before anything leaves your Mac.</span>
        </div>
        <div className="tip">
          <Icon name="hand" size={16} />
          <span>It can take over your mouse and keyboard to demonstrate — only after you allow it each time. Move your mouse or press Esc to take control back instantly.</span>
        </div>
      </div>
    </>
  );
}

function KeyStep() {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [key, setKey] = useState('');
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
    if (r.ok) {
      setMsg({ ok: true, text: r.models?.length ? `Key works. ${r.models.length} models available.` : 'Key saved.' });
      setKey('');
      setStatus(await ipc.invoke('secrets:status'));
    } else setMsg({ ok: false, text: r.error ?? 'That key did not work.' });
  };

  return (
    <>
      <h1>Connect Gemini</h1>
      <p className="lede">
        The tutor runs on your own Gemini API key. It's stored in your Mac's keychain and only sent to Google. Create one in Google AI Studio, then paste it here.
      </p>
      <div className="ob-body">
        {status?.hasKey ? (
          <div className="tip">
            <Icon name="check" size={16} />
            <span>
              Key connected ({status.preview}). <a onClick={() => void ipc.invoke('secrets:clearApiKey').then(setStatus)}>Remove it</a>
            </span>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <TextField value={key} onChange={setKey} placeholder="AIza…" type="password" width="100%" onEnter={() => void save()} mono />
              <Button variant="primary" disabled={!key.trim() || busy} onClick={() => void save()}>
                {busy ? <Spinner /> : 'Save key'}
              </Button>
            </div>
            <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Get a key at aistudio.google.com → Get API key. No key yet? Skip this — a scripted demo tutor lets you try every feature offline.
            </p>
          </>
        )}
        {msg && (
          <p style={{ marginTop: 10, color: msg.ok ? '#6ee7b7' : '#ff8a8e' }}>{msg.text}</p>
        )}
      </div>
    </>
  );
}

const PERMS: { kind: 'screen' | 'microphone' | 'accessibility'; icon: IconName; title: string; why: string }[] = [
  { kind: 'screen', icon: 'eye', title: 'Screen Recording', why: 'So the tutor can see what you see during a session.' },
  { kind: 'microphone', icon: 'mic', title: 'Microphone', why: 'So you can talk to the tutor and interrupt it.' },
  { kind: 'accessibility', icon: 'keyboard', title: 'Accessibility', why: 'For hold-to-talk, drawing with ⌃⌥, and letting the tutor drive when you allow it.' },
];

function permTone(v: string): 'ok' | 'warn' | 'bad' {
  return v === 'granted' ? 'ok' : v === 'denied' || v === 'restricted' ? 'bad' : 'warn';
}

function PermissionsStep() {
  const [p, refresh] = usePermissions(1200);
  const [asked, setAsked] = useState<Record<string, boolean>>({});

  const ask = async (kind: 'screen' | 'microphone' | 'accessibility') => {
    setAsked((a) => ({ ...a, [kind]: true }));
    await ipc.invoke('permissions:request', kind);
    await refresh();
  };

  return (
    <>
      <h1>Three permissions</h1>
      <p className="lede">macOS asks you to allow each one. Click Allow, then switch the toggle on in System Settings — this page updates by itself.</p>
      <div className="ob-body">
        {PERMS.map((perm) => {
          const v = p ? (p[perm.kind] as string) : 'unknown';
          return (
            <div className="perm-card" key={perm.kind}>
              <div className="perm-icon">
                <Icon name={perm.icon} size={17} />
              </div>
              <div>
                <div style={{ fontWeight: 600 }}>{perm.title}</div>
                <div className="why">{perm.why}</div>
              </div>
              {v === 'granted' ? (
                <Pill tone="ok" icon="check">
                  Allowed
                </Pill>
              ) : (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {asked[perm.kind] && <Pill tone={permTone(v)}>Waiting</Pill>}
                  <Button size="s" variant="primary" onClick={() => void ask(perm.kind)}>
                    Allow
                  </Button>
                  <Button size="s" variant="ghost" icon="external" onClick={() => void ipc.invoke('permissions:openSettings', perm.kind)} title="Open System Settings" />
                </div>
              )}
            </div>
          );
        })}
        {p && p.screen !== 'granted' && asked.screen && (
          <p className="muted" style={{ marginTop: 12, fontSize: 12 }}>
            After allowing Screen Recording, macOS may ask to quit and reopen {APP_NAME}. That's expected.
          </p>
        )}
        {p && <NativeNote p={p} />}
      </div>
    </>
  );
}

function NativeNote({ p }: { p: PermissionStatus }) {
  const missing = [!p.native.hooks && 'hotkeys', !p.native.input && 'takeover', !p.native.windows && 'App Veil'].filter(Boolean);
  if (!missing.length) return null;
  return (
    <div className="tip" style={{ marginTop: 12 }}>
      <Icon name="warning" size={16} />
      <span>Some native helpers didn't load ({missing.join(', ')}). Run npm install again; those features stay off until then.</span>
    </div>
  );
}

function TalkStep() {
  const [settings, update] = useSettings();
  if (!settings) return null;
  const mode = settings.talkMode;
  return (
    <>
      <h1>How do you want to talk?</h1>
      <p className="lede">You can switch any time from the session bar.</p>
      <div className="ob-body">
        <div className="choice-cards">
          <button className={`choice ${mode === 'hands-free' ? 'on' : ''}`} onClick={() => void update({ talkMode: 'hands-free' })}>
            <h4>Hands-free</h4>
            <p>Just talk. Cut the tutor off mid-sentence whenever you want. Best with headphones.</p>
            {mode === 'hands-free' && <InkRing seed={21} />}
          </button>
          <button className={`choice ${mode === 'push-to-talk' ? 'on' : ''}`} onClick={() => void update({ talkMode: 'push-to-talk' })}>
            <h4>Hold to talk</h4>
            <p>The mic only listens while you hold the keys. Good for noisy rooms and shared spaces.</p>
            {mode === 'push-to-talk' && <InkRing seed={9} />}
          </button>
        </div>
        <div style={{ marginTop: 18 }}>
          <div className="tip">
            <Icon name="pen" size={16} />
            <span>
              Hold <Kbd accel={settings.shortcuts.ask} small /> to ask about something on screen: talk, and drag to circle or underline it. Let go to send it all as one question.
            </span>
          </div>
          <div className="tip">
            <Icon name="headphones" size={16} />
            <span>Using speakers? Echo cancellation keeps the tutor from hearing itself, but headphones make interruptions most reliable.</span>
          </div>
        </div>
      </div>
    </>
  );
}

function DoneStep() {
  const [settings] = useSettings();
  return (
    <>
      <h1>You're set.</h1>
      <p className="lede">Add your courses, link each one's folder, and start a session. Notes from every session are saved into that course's folder.</p>
      <div className="ob-body">
        {settings && (
          <div className="tip">
            <Icon name="bolt" size={16} />
            <span>
              From anywhere: <Kbd accel={settings.shortcuts.toggleSession} small /> starts or ends a session, <Kbd accel={settings.shortcuts.toggleMute} small /> mutes, and{' '}
              <Kbd accel={settings.shortcuts.replay} small /> replays the last explanation.
            </span>
          </div>
        )}
      </div>
    </>
  );
}
