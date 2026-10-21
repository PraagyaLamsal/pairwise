import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { formatAccelerator } from '@shared/shortcuts';
import { Icon, type IconName } from './icons';
import { ipc } from './ipc';
import './kit.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  icon,
  size = 'm',
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: IconName; size?: 's' | 'm' | 'l' }) {
  return (
    <button className={`btn btn-${variant} btn-${size} ${className}`} {...rest}>
      {icon && <Icon name={icon} size={size === 'l' ? 18 : 15} />}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o.value} role="radio" aria-checked={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange, width }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; width?: number }) {
  return (
    <span className="select" style={width ? { width } : undefined}>
      {/* A set width wins over the default minimum (it used to overflow narrow ones). */}
      <select value={value} onChange={(e) => onChange(e.target.value as T)} style={width ? { minWidth: 0 } : undefined}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron" size={12} className="select-chevron" />
    </span>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  type = 'text',
  autoFocus,
  width,
  onEnter,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  width?: number | string;
  onEnter?: () => void;
  mono?: boolean;
}) {
  return (
    <input
      className={`field ${mono ? 'mono' : ''}`}
      style={width ? { width } : undefined}
      value={value}
      type={type}
      placeholder={placeholder}
      autoFocus={autoFocus}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
    />
  );
}

/** Shortcut rendered as macOS keycaps (⌃ ⌥ S). */
export function Kbd({ accel, small }: { accel: string; small?: boolean }) {
  const text = formatAccelerator(accel, ipc.platform);
  const parts = ipc.platform === 'darwin' ? [...text.replace('Space', '␣').replace('Esc', '⎋')] : text.split('+');
  return (
    <span className={`kbd ${small ? 'small' : ''}`}>
      {parts.map((p, i) => (
        <kbd key={i}>{p}</kbd>
      ))}
    </span>
  );
}

export function Row({ title, help, children, align = 'center' }: { title: ReactNode; help?: ReactNode; children?: ReactNode; align?: 'center' | 'start' }) {
  return (
    <div className="row" style={{ alignItems: align === 'start' ? 'flex-start' : 'center' }}>
      <div className="row-text">
        <div className="row-title">{title}</div>
        {help && <div className="row-help">{help}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  );
}

export function Group({ title, children, footer }: { title?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="group">
      {title && <h3 className="group-title">{title}</h3>}
      <div className="group-body">{children}</div>
      {footer && <div className="group-footer">{footer}</div>}
    </section>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'tutor' | 'student';

export function Pill({ tone = 'neutral', children, icon }: { tone?: Tone; children: ReactNode; icon?: IconName }) {
  return (
    <span className={`pill pill-${tone}`}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

export function Meter({ value, warnAt = 80, height = 8 }: { value: number; warnAt?: number; height?: number }) {
  const v = Math.max(0, Math.min(100, value));
  const tone = v >= 100 ? 'bad' : v >= warnAt ? 'warn' : 'ok';
  return (
    <div className={`meter meter-${tone}`} style={{ height }}>
      <div className="meter-fill" style={{ width: `${v}%` }} />
      <div className="meter-mark" style={{ left: `${warnAt}%` }} />
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 480 }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width }} ref={ref} role="dialog" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}
