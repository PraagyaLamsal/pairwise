import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { SessionCommand } from '@shared/session';
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

/** How long a caption line stays after Ada's last words (then it fades). */
const CAPTION_MS = 4000;
/** Hover this long before the bar opens; leave this long before it closes. */
const OPEN_DELAY_MS = 140;
const CLOSE_DELAY_MS = 650;

function HudButton({ icon, label, active, onClick, tone, children }: { icon: IconName; label: string; active?: boolean; onClick: () => void; tone?: 'danger' | 'warn'; children?: ReactNode }) {
  return (
    <button className={`hud-btn ${active ? 'active' : ''} ${tone ?? ''}`} onClick={onClick} title={label} aria-label={label} aria-pressed={active}>
      <Icon name={icon} size={15} />
      {children}
    </button>
  );
}

function Bars({ level, n, className }: { level: number; n: number; className: string }) {
  const profile = [0.55, 1, 0.7, 0.9, 0.5];
  return (
    <span className={className} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i} style={{ transform: `scaleY(${Math.max(0.2, Math.min(1, level * 2.6 * profile[i % profile.length])).toFixed(3)})` }} />
      ))}
    </span>
  );
}

/** The last sentence (or two, when the last one has only just started) of what Ada is saying. */
export function currentLine(text: string, max = 96): string {
  const parts = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]*\s*/g) ?? [];
  let line = parts[parts.length - 1]?.trim() ?? '';
  if (line.length < 18 && parts.length > 1) line = `${parts[parts.length - 2].trim()} ${line}`;
  return line.length > max ? `…${line.slice(line.length - max + 1).replace(/^\S*\s/, '')}` : line;
}

export function Hud() {
  const snap = useSnapshot();
  const [settings] = useSettings();
  const [levels, setLevels] = useState({ mic: 0, out: 0 });
  const [line, setLine] = useState<{ id: string; text: string; at: number } | null>(null);
  const [open, setOpen] = useState(false);
  const now = useNow(250);
  const rootRef = useRef<HTMLDivElement>(null);
  const [snapAt, setSnapAt] = useState(Date.now());
  const hoverTimer = useRef<number | null>(null);

  useIpcEvent('session:levels', setLevels);
  useIpcEvent('session:snapshot', () => setSnapAt(Date.now()));
  useIpcEvent('session:caption', (c) => {
    if (c.speaker !== 'tutor' || !c.text.trim()) return;
    setLine({ id: c.id, text: currentLine(c.text), at: Date.now() });
  });

  // Fit the window to the content.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      // The wrap's padding already leaves room for the shadow: keep the (click-blocking) window tight.
      void ipc.invoke('hud:setSize', Math.ceil(r.width) + 2, Math.ceil(r.height) + 2);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => () => void (hoverTimer.current && window.clearTimeout(hoverTimer.current)), []);
  const hover = (on: boolean) => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setOpen(on), on ? OPEN_DELAY_MS : CLOSE_DELAY_MS);
  };

  // Drag the bar around by its left end (it remembers where you put it, per display).
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onGripDown = (e: ReactPointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY, moved: false };
  };
  const onGripMove = (e: ReactPointerEvent) => {
    if (!drag.current) return;
    const dx = e.screenX - drag.current.x;
    const dy = e.screenY - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) < 1) return;
    drag.current = { x: e.screenX, y: e.screenY, moved: true };
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
  const driving = snap.driving === 'driving';
  const ptt = snap.talkMode === 'push-to-talk';
  const micOpen = !snap.muted && (!ptt || snap.pttHeld);
  const seeing = snap.vision === 'on';
  const status = connecting ? 'connecting…' : reconnecting ? 'reconnecting…' : asking ? 'listening to your question' : (activityText[snap.activity] ?? '');
  const lineAge = line ? now - line.at : Infinity;
  const showLine = snap.captions && line && lineAge < CAPTION_MS + 500;
  // Quiet unless something needs you: asking, driving or a problem keep the bar at full strength.
  const loud = open || asking || driving || connecting || reconnecting;

  return (
    <div className="hud-wrap" ref={rootRef}>
      <div
        className={`hud ${open ? 'open' : ''} ${loud ? 'loud' : ''} ${driving ? 'driving' : ''} ${asking ? 'asking' : ''}`}
        onMouseEnter={() => hover(true)}
        onMouseLeave={() => hover(false)}
      >
        <div className="hud-grip" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} title="Drag to move">
          <span className={`course-dot ${connecting || reconnecting ? 'pending' : ''}`} style={{ background: snap.courseColor ?? 'var(--tutor)' }} />
          {open && <span className="course-code">{snap.courseLabel ?? 'Session'}</span>}
          <span className="timer">{clock(elapsed)}</span>
          {snap.demo && (
            <span className="demo-badge" title="Demo tutor — add your Gemini key in Settings for the real one.">
              demo
            </span>
          )}
        </div>

        <button className={`mic ${snap.muted ? 'muted' : ''} ${micOpen ? 'open' : ''}`} onClick={() => send({ type: 'toggleMute' })} title={snap.muted ? 'Unmute' : ptt ? 'Mute (in hold-to-talk, hold the ask keys while you speak)' : 'Mute'} aria-label={snap.muted ? 'Unmute microphone' : 'Mute microphone'}>
          <Icon name={snap.muted ? 'micOff' : 'mic'} size={15} />
          {!snap.muted && micOpen && <Bars level={levels.mic} n={3} className="mic-bars" />}
          {!snap.muted && ptt && !snap.pttHeld && settings && <Kbd accel={settings.shortcuts.ask} small />}
        </button>

        <span className={`tutor-state ${snap.activity} ${asking ? 'asking' : ''}`} title={`${tutor} is ${status}`}>
          {snap.activity === 'speaking' ? <Bars level={levels.out} n={4} className="tutor-bars" /> : snap.activity === 'thinking' || connecting || reconnecting ? <span className="tutor-dots"><span /><span /><span /></span> : <span className="tutor-glyph" />}
          {open && (
            <>
              <span className="tutor-name">{tutor}</span>
              <span className="tutor-act">{status}</span>
            </>
          )}
        </span>

        <HudButton
          icon={seeing ? 'eye' : 'eyeOff'}
          label={seeing ? `${tutor} can see ${snap.visibleDisplayLabel ?? 'your screen'} — click to pause` : 'Screen view paused — click to resume'}
          active={seeing}
          tone={seeing ? undefined : 'warn'}
          onClick={() => send({ type: 'toggleVision' })}
        />

        {open && (
          <span className="hud-more">
            <button className="mode" onClick={() => send({ type: 'toggleTalkMode' })} title="Switch talk mode">
              {snap.talkMode === 'hands-free' ? 'Hands-free' : settings ? <>Hold <Kbd accel={settings.shortcuts.ask} small /></> : 'Hold to talk'}
            </button>
            <span className="sep" />
            <HudButton icon="pen" label={asking ? 'Send what you drew' : 'Draw on screen'} active={asking} onClick={() => send({ type: 'drawToggle' })} />
            <HudButton icon="board" label="Whiteboard" active={snap.whiteboard} onClick={() => send({ type: 'toggleWhiteboard' })} />
            <HudButton icon="replay" label="Say that again" onClick={() => send({ type: 'replay' })} />
            <HudButton icon="captions" label={snap.captions ? 'Hide captions' : 'Show captions'} active={snap.captions} onClick={() => send({ type: 'toggleCaptions' })} />
          </span>
        )}

        {snap.mediaPausedByUs && (
          <HudButton icon="play" label={`${tutor} paused your video — click to resume it`} onClick={() => send({ type: 'toggleMedia' })} tone="warn">
            {open && <span className="btn-text">Resume video</span>}
          </HudButton>
        )}
        {driving && (
          <button className="driving-chip" onClick={() => send({ type: 'reclaim' })} title="Take back control">
            <Icon name="hand" size={13} /> {tutor} is driving · <Kbd accel="Escape" small />
          </button>
        )}

        <button className="end" onClick={() => void ipc.invoke('session:end')} title="End session">
          End
        </button>
      </div>

      {snap.notice && <div className="hud-note warn">{snap.notice}</div>}

      {showLine && (
        <div className={`captions ${lineAge > CAPTION_MS ? 'gone' : ''}`} aria-live="polite">
          <div className="cap tutor final">
            <span className="what">{line!.text}</span>
          </div>
        </div>
      )}
    </div>
  );
}
