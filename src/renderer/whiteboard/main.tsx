import '@fontsource/caveat/700.css';
import '@fontsource-variable/inter';
import '../ui/tokens.css';
import '../ui/base.css';
import './whiteboard.css';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Point } from '@shared/geometry';
import type { InkItem } from '@shared/ink';
import type { InkOp } from '@shared/ipc';
import type { SessionSnapshot } from '@shared/session';
import { ipc } from '../ui/ipc';
import { FADE_MS, InkRenderer } from '../ui/ink-render';
import { Icon } from '../ui/icons';

/** Board space: 1000 × 640 units, letterboxed into the window (main maps the tutor's pen the same way). */
const BOARD = { width: 1000, height: 640 };

type Tool = 'pen' | 'eraser';

const items = new Map<string, InkItem>();
const renderer = new InkRenderer();
let dirty = true;
let onItemsChanged: () => void = () => undefined;

function applyInk(op: InkOp): void {
  switch (op.op) {
    case 'add':
    case 'update':
      for (const it of op.items) {
        if (op.op === 'update') renderer.forget(it.id);
        items.set(it.id, it);
      }
      break;
    case 'remove':
      for (const id of op.ids) {
        items.delete(id);
        renderer.forget(id);
      }
      break;
    case 'fade':
      for (const it of items.values()) {
        if (op.ids && !op.ids.includes(it.id)) continue;
        if (op.group && it.group !== op.group) continue;
        if (op.author && it.author !== op.author) continue;
        if (it.fadeAt == null || it.fadeAt > op.at) it.fadeAt = op.at;
      }
      break;
    case 'clear':
      for (const [id, it] of items) {
        if (op.author && it.author !== op.author) continue;
        if (op.group && it.group !== op.group) continue;
        items.delete(id);
        renderer.forget(id);
      }
      break;
  }
  dirty = true;
  onItemsChanged();
}

function layout(w: number, h: number) {
  const scale = Math.min(w / BOARD.width, h / BOARD.height);
  return { scale, ox: (w - BOARD.width * scale) / 2, oy: (h - BOARD.height * scale) / 2 };
}

function Board() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [title, setTitle] = useState('Whiteboard');
  const [tutor, setTutor] = useState('Ada');
  const [studentColor, setStudentColor] = useState('#FF8A1F');
  const [tool, setTool] = useState<Tool>('pen');
  const [drawing, setDrawing] = useState(false);
  const [snap, setSnap] = useState<SessionSnapshot | null>(null);
  const [count, setCount] = useState(0);
  onItemsChanged = () => setCount(items.size);
  const live = useRef<Point[] | null>(null);
  const toolRef = useRef<Tool>('pen');
  toolRef.current = tool;

  useEffect(() => {
    const init = (m: { title: string; tutorName: string; tutorColor: string; studentColor: string; items: InkItem[] }) => {
      setTitle(m.title);
      setTutor(m.tutorName);
      setStudentColor(m.studentColor);
      document.documentElement.style.setProperty('--tutor', m.tutorColor);
      document.documentElement.style.setProperty('--student', m.studentColor);
      items.clear();
      renderer.clearCache();
      for (const it of m.items) items.set(it.id, it);
      dirty = true;
      setCount(items.size);
    };
    void ipc.invoke('whiteboard:state').then(init).catch(() => undefined);
    const offs = [
      ipc.on('whiteboard:init', (m) => {
        setTitle(m.title);
        setTutor(m.tutorName);
        setStudentColor(m.studentColor);
        document.documentElement.style.setProperty('--tutor', m.tutorColor);
        document.documentElement.style.setProperty('--student', m.studentColor);
        items.clear();
        renderer.clearCache();
        for (const it of m.items) items.set(it.id, it);
        dirty = true;
        setCount(items.size);
      }),
      ipc.on('whiteboard:ink', (op) => applyInk(op)),
      ipc.on('session:snapshot', (s) => setSnap(s)),
    ];
    void document.fonts.ready.then(() => (dirty = true));
    return () => offs.forEach((o) => o());
  }, []);

  // Render loop: board background + grid, then ink in board units.
  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    let raf = 0;
    let was = false;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(window.innerWidth * dpr);
      canvas.height = Math.round(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
      dirty = true;
    };
    window.addEventListener('resize', resize);
    resize();
    const frame = () => {
      const now = Date.now();
      for (const [id, it] of items) {
        if (it.fadeAt != null && now > it.fadeAt + FADE_MS + 100) {
          items.delete(id);
          renderer.forget(id);
          dirty = true;
        }
      }
      const list = [...items.values()];
      const anim = renderer.animating(list, now) || live.current !== null;
      if (dirty || anim || was) {
        const dpr = window.devicePixelRatio || 1;
        const { scale, ox, oy } = layout(window.innerWidth, window.innerHeight);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // dot grid over the board area
        ctx.setTransform(dpr * scale, 0, 0, dpr * scale, ox * dpr, oy * dpr);
        ctx.fillStyle = 'rgba(255,255,255,0.075)';
        for (let x = 20; x < BOARD.width; x += 25) for (let y = 20; y < BOARD.height; y += 25) ctx.fillRect(x - 0.9, y - 0.9, 1.8, 1.8);
        renderer.render(ctx, list, now, dpr * scale);
        if (live.current && live.current.length) {
          renderer.forget('__live__');
          const pts = live.current.length === 1 ? [live.current[0], { x: live.current[0].x + 0.5, y: live.current[0].y }] : live.current;
          renderer.render(ctx, [{ id: '__live__', author: 'student', kind: 'stroke', color: studentColorRef.current, surface: 'whiteboard', points: pts, revealAt: 0, drawMs: 1, seed: 1 }], now, dpr * scale);
        }
        dirty = false;
      }
      was = anim;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const studentColorRef = useRef(studentColor);
  studentColorRef.current = studentColor;

  const toBoard = (e: React.PointerEvent): Point => {
    const { scale, ox, oy } = layout(window.innerWidth, window.innerHeight);
    return { x: (e.clientX - ox) / scale, y: (e.clientY - oy) / scale };
  };

  const eraseAt = (p: Point) => {
    for (const it of items.values()) {
      if (it.author !== 'student' || !it.points) continue;
      if (it.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 14)) ipc.send('whiteboard:stroke', { id: `erase:${it.id}`, points: [], times: [], straight: false, displayId: '', surface: 'whiteboard' });
    }
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const p = toBoard(e);
    if (toolRef.current === 'eraser') return eraseAt(p);
    live.current = [p];
    setDrawing(true);
    dirty = true;
  };
  const onMove = (e: React.PointerEvent) => {
    if (toolRef.current === 'eraser') {
      if (e.buttons & 1) eraseAt(toBoard(e));
      return;
    }
    if (!live.current) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [e.nativeEvent];
    for (const ce of events.length ? events : [e.nativeEvent]) {
      const { scale, ox, oy } = layout(window.innerWidth, window.innerHeight);
      const p = { x: (ce.clientX - ox) / scale, y: (ce.clientY - oy) / scale };
      const last = live.current[live.current.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) >= 0.8) live.current.push(p);
    }
    dirty = true;
  };
  const onUp = () => {
    const pts = live.current;
    live.current = null;
    setDrawing(false);
    if (pts && pts.length) ipc.send('whiteboard:stroke', { id: `ws-${Date.now()}`, points: pts.length === 1 ? [pts[0], { x: pts[0].x + 0.5, y: pts[0].y + 0.5 }] : pts, times: [], straight: false, displayId: '', surface: 'whiteboard' });
    dirty = true;
  };

  const tutorBusy = snap?.activity === 'speaking' || snap?.activity === 'thinking';

  return (
    <div className={`board ${tool}`} data-platform={ipc.platform}>
      <div className="board-bar">
        <span className="board-title">{title}</span>
        {snap && snap.status === 'live' && (
          <span className={`board-presence ${tutorBusy ? 'busy' : ''}`}>
            <span className="dot" /> {tutor} {snap.activity === 'speaking' ? 'is explaining' : snap.activity === 'thinking' ? 'is thinking' : 'can see this board'}
          </span>
        )}
      </div>
      <canvas ref={canvasRef} className="board-canvas" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} />
      {count === 0 && !drawing && (
        <div className="board-empty">
          <div className="hand">Draw here, or ask {tutor} to sketch it out.</div>
          <div className="muted">Trees, linked lists, arrays, flowcharts — anything there's nothing on screen to draw on.</div>
        </div>
      )}
      <div className="board-tools" role="toolbar">
        <button className={tool === 'pen' ? 'on' : ''} onClick={() => setTool('pen')} title="Pen" aria-label="Pen">
          <Icon name="pen" size={16} />
          <span className="swatch" style={{ background: studentColor }} />
        </button>
        <button className={tool === 'eraser' ? 'on' : ''} onClick={() => setTool('eraser')} title="Erase your strokes" aria-label="Eraser">
          <Icon name="eraser" size={16} />
        </button>
        <span className="sep" />
        <button onClick={() => ipc.send('whiteboard:clear', {})} title="Clear the board" aria-label="Clear the board">
          <Icon name="trash" size={16} />
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Board />);
