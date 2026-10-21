import './onboarding-art.css';

/**
 * Looping illustration of a session, drawn the way Ada really looks (flat cursor, flat
 * round-ended ink, typed notes): her cursor goes to the base case, circles it and types a note,
 * then the student underlines the recursive call in their own colour.
 */
export function OnboardingArt() {
  return (
    <div className="ob-scene" aria-hidden="true">
      <div className="ob-window">
        <div className="ob-titlebar">
          <span />
          <span />
          <span />
          <em>factorial.py</em>
        </div>
        <pre className="ob-code">
          <span className="k">def</span> <span className="f">factorial</span>(n):{'\n'}
          {'    '}<span className="k">if</span> <span className="hl">n == 0</span>:{'\n'}
          {'        '}<span className="k">return</span> <span className="n">1</span>{'\n'}
          {'    '}<span className="k">return</span> n * <span className="u">factorial(n - 1)</span>{'\n'}
          {'\n'}
          <span className="f">print</span>(factorial(<span className="n">5</span>))
        </pre>
        <svg className="ob-ink" viewBox="0 0 420 186">
          <path className="ring" pathLength={1} d="M 82 41 C 66 43, 58 52, 63 60 C 70 70, 112 72, 128 64 C 141 57, 134 44, 108 40 C 96 38, 84 40, 74 45" />
          <path className="arrow" pathLength={1} d="M 196 34 C 176 36, 156 44, 140 52" />
          <path className="arrow-head" pathLength={1} d="M 147 44 L 139 53 L 151 56" />
          <path className="underline" pathLength={1} d="M 136 117 C 172 120, 222 114, 264 118" />
        </svg>
        <div className="ob-note">
          {[...'base case'].map((ch, i) => (
            <span key={i} style={{ animationDelay: `${i * 70}ms` }}>
              {ch}
            </span>
          ))}
        </div>
        <div className="ob-cursor">
          <svg width="26" height="26" viewBox="0 0 26 26">
            <path d="M3 3 L3 20.6 L7.4 16.6 L10.4 23.4 L13.5 22.1 L10.6 15.4 L16.6 15.4 Z" fill="#2f7bff" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
          </svg>
          <span className="ob-label">Ada</span>
        </div>
      </div>
      <div className="ob-caption">
        <span className="who student">You</span> why does it stop at zero?
        <br />
        <span className="who tutor">Ada</span> that's the base case — see this line?
      </div>
    </div>
  );
}
