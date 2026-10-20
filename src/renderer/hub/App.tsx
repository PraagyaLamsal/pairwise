import { useEffect, useState } from 'react';
import { APP_NAME } from '@shared/app-info';
import type { AppInfo } from '@shared/ipc';
import { Icon, type IconName } from '../ui/icons';
import { ipc } from '../ui/ipc';
import { useIpcEvent, useSettings, useSnapshot } from '../ui/hooks';
import { Kbd } from '../ui/kit';
import { Courses } from './pages/Courses';
import { Onboarding } from './pages/Onboarding';
import { SettingsPage } from './pages/Settings';
import { Usage } from './pages/Usage';
import { Diagnostics } from './pages/Diagnostics';

type Tab = 'courses' | 'settings' | 'usage' | 'diagnostics' | 'onboarding';

const NAV: { tab: Tab; label: string; icon: IconName }[] = [
  { tab: 'courses', label: 'Courses', icon: 'courses' },
  { tab: 'settings', label: 'Settings', icon: 'gear' },
  { tab: 'usage', label: 'Usage', icon: 'gauge' },
  { tab: 'diagnostics', label: 'Setup & checks', icon: 'shield' },
];

function initialTab(): Tab {
  const t = new URLSearchParams(location.search).get('tab');
  return (['courses', 'settings', 'usage', 'diagnostics', 'onboarding'].includes(t ?? '') ? t : 'courses') as Tab;
}

export function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [settings] = useSettings();
  const snap = useSnapshot();

  useEffect(() => {
    void ipc.invoke('app:info').then(setInfo).catch(() => undefined);
  }, []);
  useIpcEvent('hub:navigate', ({ tab: t }) => setTab((t as Tab) || 'courses'));

  if (tab === 'onboarding') {
    return <Onboarding onDone={() => setTab('courses')} />;
  }

  const live = snap.status === 'live' || snap.status === 'connecting' || snap.status === 'reconnecting' || snap.status === 'starting';

  return (
    <div className={`hub ${ipc.platform === 'darwin' ? 'mac' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="22" height="22">
              <path d="M5 3.5 L19 11.2 L12.6 13 L9.6 19.4 Z" fill="var(--tutor)" stroke="#cfe0ff" strokeWidth="1.2" strokeLinejoin="round" />
            </svg>
          </span>
          <span className="brand-name">{APP_NAME}</span>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.tab} className={`nav-item ${tab === n.tab ? 'active' : ''}`} onClick={() => setTab(n.tab)}>
              <Icon name={n.icon} size={16} />
              {n.label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {live ? (
            <div className="live-chip">
              <span className="live-dot" /> Live · {snap.courseLabel}
            </div>
          ) : (
            settings && (
              <div className="hint">
                <Kbd accel={settings.shortcuts.toggleSession} small /> starts your last course from anywhere
              </div>
            )
          )}
          {info?.demo && <div className="demo-chip">Demo tutor · add a Gemini key in Settings</div>}
        </div>
      </aside>
      <main className="content">
        {tab === 'courses' && <Courses />}
        {tab === 'settings' && <SettingsPage />}
        {tab === 'usage' && <Usage />}
        {tab === 'diagnostics' && <Diagnostics onOnboarding={() => setTab('onboarding')} />}
      </main>
    </div>
  );
}
