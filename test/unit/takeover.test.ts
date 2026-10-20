import { describe, expect, it } from 'vitest';
import { riskOf, spokenConsent, SyntheticTracker } from '../../src/main/session/takeover-rules';

describe('risky actions need an explicit yes', () => {
  it('flags submitting, sending, deleting, buying', () => {
    expect(riskOf({ type: 'click', target: 'the Submit button' })).toMatch(/Submit/);
    expect(riskOf({ type: 'click', target: 'Send' })).toBeTruthy();
    expect(riskOf({ type: 'right_click', target: 'Delete file' })).toBeTruthy();
    expect(riskOf({ type: 'click', target: 'Buy now' })).toBeTruthy();
    expect(riskOf({ type: 'double_click', target: 'Run' })).toBeTruthy();
    expect(riskOf({ type: 'drag', target: 'notes.txt', to_target: 'the Trash' })).toBeTruthy();
  });
  it('lets ordinary navigation through', () => {
    expect(riskOf({ type: 'click', target: 'the View menu' })).toBeNull();
    expect(riskOf({ type: 'click', target: 'the Settings gear' })).toBeNull();
    expect(riskOf({ type: 'scroll', direction: 'down' })).toBeNull();
    expect(riskOf({ type: 'type', text: 'hello world' })).toBeNull();
    expect(riskOf({ type: 'key', keys: ['cmd', 'c'] })).toBeNull();
    expect(riskOf({ type: 'key', keys: ['tab'] })).toBeNull();
  });
  it('running commands: Return in a terminal, or after typing a shell command', () => {
    expect(riskOf({ type: 'key', keys: ['enter'] }, { frontApp: 'Terminal' })).toMatch(/run/);
    expect(riskOf({ type: 'key', keys: ['return'] }, { typedBefore: 'rm -rf build' })).toMatch(/rm -rf build/);
    expect(riskOf({ type: 'type', text: 'python3 main.py\n' })).toMatch(/run/);
    expect(riskOf({ type: 'key', keys: ['enter'] }, { frontApp: 'Visual Studio Code', typedBefore: 'x = 1' })).toBeNull();
  });
  it('dangerous shortcuts', () => {
    expect(riskOf({ type: 'key', keys: ['cmd', 'enter'] })).toBeTruthy();
    expect(riskOf({ type: 'key', keys: ['cmd', 'backspace'] })).toBeTruthy();
    expect(riskOf({ type: 'key', keys: ['cmd', 'q'] })).toBeTruthy();
    expect(riskOf({ type: 'key', keys: ['enter'] }, { explain: 'Now I submit the form' })).toMatch(/submit/i);
  });
});

describe('synthetic vs real input', () => {
  it('recognises the pointer moves we made, and nothing else', () => {
    const t = new SyntheticTracker();
    t.noteMove({ x: 100, y: 100 }, 1000);
    t.noteMove({ x: 120, y: 110 }, 1016);
    expect(t.isOurMove({ x: 120, y: 111 }, 1030)).toBe(true);
    expect(t.isOurMove({ x: 100, y: 100 }, 1040)).toBe(true);
    expect(t.isOurMove({ x: 160, y: 140 }, 1040)).toBe(false); // the student's hand
    expect(t.isOurMove({ x: 120, y: 110 }, 2000)).toBe(false); // too late to be ours
  });
  it('knows when key and button events are ours', () => {
    const t = new SyntheticTracker();
    t.noteKeys(100, 1000);
    expect(t.isOurKey(1150)).toBe(true);
    expect(t.isOurKey(1300)).toBe(false);
    t.noteButtons(50, 2000);
    expect(t.isOurButton(2100)).toBe(true);
    expect(t.isOurButton(2400)).toBe(false);
  });
});

describe('spoken consent', () => {
  it('reads yes and no', () => {
    expect(spokenConsent('Yeah, go ahead')).toBe('yes');
    expect(spokenConsent('sure, show me')).toBe('yes');
    expect(spokenConsent('okay')).toBe('yes');
    expect(spokenConsent('no, let me try it myself')).toBe('no');
    expect(spokenConsent("not now, I'll do it")).toBe('no');
    expect(spokenConsent('what does the second line do')).toBeNull();
  });
});
