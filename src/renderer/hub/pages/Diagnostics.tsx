import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc';
import { Icon } from '../../ui/icons';
import { ipc } from '../../ui/ipc';
import { usePermissions } from '../../ui/hooks';
import { Button, Group, Pill, Row } from '../../ui/kit';

const label = (v: string) => (v === 'granted' ? 'Allowed' : v === 'not-determined' ? 'Not asked yet' : v === 'denied' ? 'Not allowed' : v);

export function Diagnostics({ onOnboarding }: { onOnboarding: () => void }) {
  const [p] = usePermissions(2000);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [testMsg, setTestMsg] = useState<string | null>(null);
  useEffect(() => {
    void ipc.invoke('app:info').then(setInfo);
  }, []);

  const runTest = async () => {
    setTestMsg('Running… look at your screens.');
    const r = await ipc.invoke('diagnostics:pointingTest');
    setTestMsg(r.ok ? (r.summary ?? 'Done — results are on screen.') : (r.error ?? 'Could not run the test.'));
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Setup & checks</h1>
          <p>Permissions, native helpers and a pointing-accuracy test you can run on your own screens.</p>
        </div>
        <Button variant="secondary" icon="refresh" onClick={onOnboarding}>
          Run setup again
        </Button>
      </div>
      {p && (
        <Group title="macOS permissions">
          {(['screen', 'microphone', 'accessibility'] as const).map((k) => (
            <Row key={k} title={k === 'screen' ? 'Screen Recording' : k === 'microphone' ? 'Microphone' : 'Accessibility'}>
              <Pill tone={p[k] === 'granted' ? 'ok' : 'warn'}>{label(p[k])}</Pill>
              {p[k] !== 'granted' && (
                <Button size="s" variant="ghost" icon="external" onClick={() => void ipc.invoke('permissions:openSettings', k)}>
                  Open settings
                </Button>
              )}
            </Row>
          ))}
        </Group>
      )}
      {p && (
        <Group title="Native helpers (prebuilt, loaded at startup)">
          <Row title="Global hold keys & instant reclaim" help="uiohook-napi">
            <Pill tone={p.native.hooks ? 'ok' : 'bad'}>{p.native.hooks ? 'Loaded' : 'Missing'}</Pill>
          </Row>
          <Row title="Takeover input" help="@jitsi/robotjs">
            <Pill tone={p.native.input ? 'ok' : 'bad'}>{p.native.input ? 'Loaded' : 'Missing'}</Pill>
          </Row>
          <Row title="Window detection for App Veil" help="get-windows">
            <Pill tone={p.native.windows ? 'ok' : 'bad'}>{p.native.windows ? 'Loaded' : 'Missing'}</Pill>
          </Row>
        </Group>
      )}
      <Group title="Pointing accuracy" footer="Draws labelled targets on every display, asks Gemini to find each one on a real screenshot, and reports how many pixels off it landed. Needs an API key and Screen Recording.">
        <Row title="Run the test" help={testMsg ?? 'Takes about 15 seconds.'}>
          <Button size="s" variant="primary" icon="pointer" onClick={() => void runTest()}>
            Start test
          </Button>
        </Row>
        <Row title="Preview the cursor and ink" help="A short scripted demo, no API calls.">
          <Button size="s" icon="sparkle" onClick={() => void ipc.invoke('diagnostics:previewInk')}>
            Preview
          </Button>
        </Row>
      </Group>
      {info && (
        <p className="muted" style={{ fontSize: 12 }}>
          <Icon name="info" size={12} /> {info.appName} {info.version} · {info.platform}
          {info.fakePlatform ? ' · fake platform' : ''}
          {info.demo ? ' · demo tutor' : ''}
        </p>
      )}
    </div>
  );
}
