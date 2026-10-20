import './onboarding-art.css';

/**
 * Looping illustration of a session: the tutor's cursor swoops to the base case, circles it
 * and labels it, then the student underlines the recursive call.
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
        <div className="ob-note">base case</div>
        <div className="ob-cursor">
          <svg width="22" height="22" viewBox="0 0 22 22">
            <path d="M3 2 L19 10.4 L11.7 12.4 L8.4 19.6 Z" fill="url(#cg)" stroke="#d6e6ff" strokeWidth="1.2" strokeLinejoin="round" />
            <defs>
              <linearGradient id="cg" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#8ab8ff" />
                <stop offset="1" stopColor="#2f7bff" />
              </linearGradient>
            </defs>
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
