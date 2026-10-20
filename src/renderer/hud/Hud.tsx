import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { Caption, SessionCommand } from '@shared/session';
import { formatUsd } from '@shared/pricing';
import { Icon, type IconName } from '../ui/icons';
import { ipc } from '../ui/ipc';
import { useIpcEvent, useNow, useSettings, useSnapshot } from '../ui/hooks';
import { Kbd } from '../ui/kit';

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

const send = (cmd: SessionCommand) => void ipc.invoke('session:command', cmd);

function HudButton({ icon, label, active, onClick, tone, children }: { icon: IconName; label: string; active?: boolean; onClick: () => void; tone?: 'danger' | 'warn'; children?: ReactNode }) {
  return (
    <button className={`hud-btn ${active ? 'active' : ''} ${tone ?? ''}`} onClick={onClick} title={label} aria-label={label} aria-pressed={active}>
      <Icon name={icon} size={16} />
      {children}
    </button>
  );
}

function MicBars({ level, muted }: { level: number; muted: boolean }) {
  const bars = [0.5, 0.85, 1, 0.75, 0.45];
  return (
    <span className={`mic-bars ${muted ? 'muted' : ''}`} aria-hidden="true">
      {bars.map((b, i) => (
        <span key={i} style={{ transform: `scaleY(${muted ? 0.18 : Math.max(0.18, Math.min(1, level * 2.4 * b))})` }} />
      ))}
    </span>
  );
}

export function Hud() {
  const snap = useSnapshot();
  const [settings] = useSettings();
  const [levels, setLevels] = useState({ mic: 0, out: 0 });
  const [captions, setCaptions] = useState<Caption[]>([]);
  const now = useNow(500);
  const rootRef = useRef<HTMLDivElement>(null);
  const [snapAt, setSnapAt] = useState(Date.now());

  useIpcEvent('session:levels', setLevels);
  useIpcEvent('session:snapshot', () => setSnapAt(Date.now()));
  useIpcEvent('session:caption', (c) => {
    setCaptions((list) => {
      const i = list.findIndex((x) => x.id === c.id);
      const next = i >= 0 ? list.map((x, j) => (j === i ? c : x)) : [...list, c];
      return next.slice(-6);
    });
  });

  // Fit the window to the content.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      void ipc.invoke('hud:setSize', Math.ceil(r.width) + 24, Math.ceil(r.height) + 24);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Drag the bar around by its grip.
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onGripDown = (e: ReactPointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY };
  };
  const onGripMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const dx = e.screenX - drag.current.x;
    const dy = e.screenY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    drag.current = { x: e.screenX, y: e.screenY };
    void ipc.invoke('hud:moveBy', dx, dy);
  };
  const onGripUp = () => (drag.current = null);

  const elapsed = snap.elapsedMs + (snap.status === 'live' ? Math.max(0, now - snapAt) : 0);
  const tutor = settings?.tutorName ?? 'Ada';
  const activityText: Record<string, string> = {
    idle: 'ready',
    listening: 'listening',
    thinking: 'thinking',
    speaking: 'talking',
    waiting: 'waiting for you',
  };
  // Holding the ask keys / draw mode: everything said and drawn goes as one question.
  const asking = snap.pttHeld && snap.status === 'live';
  const connecting = snap.status === 'connecting' || snap.status === 'starting';
  const reconnecting = snap.status === 'reconnecting';
  const visibleCaptions = snap.captions ? captions.filter((c) => c.text.trim()).slice(-2) : [];
  const lastTutor = [...captions].reverse().find((c) => c.speaker === 'tutor');

  return (
    <div className="hud-wrap" ref={rootRef}>
      <div className={`hud ${snap.driving === 'driving' ? 'driving' : ''} ${asking ? 'asking' : ''}`}>
        <div className="hud-grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} title="Drag to move">
          <span className="course-dot" style={{ background: snap.courseColor ?? 'var(--tutor)' }} />
          <span className="course-code">{snap.courseLabel ?? 'Session'}</span>
          <span className={`rec ${connecting || reconnecting ? 'pending' : ''}`} />
          <span className="timer">{clock(elapsed)}</span>
        </div>

        <span className="sep" />

        <button className={`mic ${snap.muted ? 'muted' : ''}`} onClick={() => send({ type: 'toggleMute' })} title={snap.muted ? 'Unmute' : 'Mute'} aria-label={snap.muted ? 'Unmute microphone' : 'Mute microphone'}>
          <Icon name={snap.muted ? 'micOff' : 'mic'} size={16} />
          <MicBars level={levels.mic} muted={snap.muted || (snap.talkMode === 'push-to-talk' && !snap.pttHeld)} />
        </button>
        <button className="mode" onClick={() => send({ type: 'toggleTalkMode' })} title="Switch talk mode">
          {snap.talkMode === 'hands-free' ? 'Hands-free' : settings ? <>Hold <Kbd accel={settings.shortcuts.ask} small /></> : 'Hold to talk'}
        </button>

        <span className="sep" />

        <span className={`tutor-state ${snap.activity}`} title={`${tutor} is ${activityText[snap.activity] ?? snap.activity}`}>
          <span className="tutor-glyph" />
          <span className="tutor-name">{tutor}</span>
          <span className="tutor-act">{connecting ? 'connecting…' : reconnecting ? 'reconnecting…' : asking ? 'listening to your question' : (activityText[snap.activity] ?? '')}</span>
        </span>

        <span className="sep" />

        <HudButton icon={snap.vision === 'on' ? 'eye' : 'eyeOff'} label={snap.vision === 'on' ? `${tutor} can see ${snap.visibleDisplayLabel ?? 'your screen'} — click to pause` : 'Screen view paused — click to resume'} active={snap.vision === 'on'} onClick={() => send({ type: 'toggleVision' })} />
        <HudButton icon="pen" label={asking ? 'Send what you drew' : 'Draw on screen'} active={asking} onClick={() => send({ type: 'drawToggle' })} />
        <HudButton icon="board" label="Whiteboard" active={snap.whiteboard} onClick={() => send({ type: 'toggleWhiteboard' })} />
        <HudButton icon="replay" label="Say that again" onClick={() => send({ type: 'replay' })} />
        <HudButton icon="captions" label={snap.captions ? 'Hide captions' : 'Show captions'} active={snap.captions} onClick={() => send({ type: 'toggleCaptions' })} />
        {snap.mediaPausedByUs && (
          <HudButton icon="play" label="Resume the paused video" onClick={() => send({ type: 'toggleMedia' })} tone="warn">
            <span className="btn-text">Resume video</span>
          </HudButton>
        )}
        {snap.driving === 'driving' && (
          <button className="driving-chip" onClick={() => send({ type: 'reclaim' })} title="Take back control">
            <Icon name="hand" size={14} /> {tutor} is driving · <Kbd accel="Escape" small />
          </button>
        )}

        <button className="end" onClick={() => void ipc.invoke('session:end')} title="End session">
          End
        </button>
      </div>

      {snap.demo && <div className="hud-note">Demo tutor — add your Gemini key in Settings for the real one.</div>}
      {snap.notice && <div className="hud-note warn">{snap.notice}</div>}
      {snap.costUsd > 0 && <div className="hud-cost" title="Spent this session">{formatUsd(snap.costUsd)}</div>}

      {visibleCaptions.length > 0 && (
        <div className="captions" aria-live="polite">
          {visibleCaptions.map((c) => (
            <div key={c.id} className={`cap ${c.speaker} ${c.final ? 'final' : ''}`}>
              <span className="who">{c.speaker === 'student' ? 'You' : c.speaker === 'tutor' ? tutor : '•'}</span>
              <span className="what">{c.text}</span>
            </div>
          ))}
          {lastTutor?.cites && lastTutor.cites.length > 0 && (
            <div className="cites">
              {lastTutor.cites.map((ci) => (
                <span key={ci} className="cite">
                  <Icon name="file" size={11} /> {ci}
                </span>
              ))}
            </div>
          )}
          {lastTutor?.outOfScope && <div className="scope">Beyond this course: {lastTutor.outOfScope}</div>}
        </div>
      )}
    </div>
  );
}
