import type { Rect } from '@shared/geometry';
import type { GeminiRest } from '../gemini/rest';
import type { FrameSource } from './grounder';
import { runTesseract } from './grounder';
import { logger } from '../log';

const log = logger('reader');

export interface ReadResult {
  ok: boolean;
  text: string;
  via: 'gemini' | 'ocr' | 'none';
  error?: string;
}

/**
 * read_screen: transcribe text or code exactly from a full-resolution capture (or a crop around
 * the tutor's estimate), so the tutor never quotes code it only half-saw in the live stream.
 */
export class ScreenReader {
  constructor(
    private readonly rest: GeminiRest,
    private readonly frames: FrameSource,
    private readonly model: () => string,
    private readonly ocrFallback: boolean,
  ) {}

  async read(displayId: string, region: string, crop?: Rect): Promise<ReadResult> {
    const frame = await this.frames.capture(displayId, { maxWidth: crop ? 1800 : 2400, crop });
    if (!frame) return { ok: false, text: '', via: 'none', error: 'Could not capture the screen.' };
    if (!this.rest.hasKey) {
      if (!this.ocrFallback) return { ok: false, text: '', via: 'none', error: 'Reading needs a Gemini key (demo mode).' };
      const words = await runTesseract(frame.data, frame.mime);
      const lines = new Map<string, string[]>();
      for (const w of words) lines.set(w.line, [...(lines.get(w.line) ?? []), w.text]);
      return { ok: words.length > 0, text: [...lines.values()].map((l) => l.join(' ')).join('\n'), via: 'ocr' };
    }
    const prompt = [
      `Transcribe exactly: ${region}.`,
      'Copy the text or code character for character: keep line breaks, indentation, punctuation, symbols and capitalization. Include line numbers if the editor shows them. Do not explain or fix anything.',
      'If the requested part is not visible, reply with exactly NOT_VISIBLE and one short sentence saying what is on screen instead.',
      'Black areas labelled "hidden by App Veil" are private — never describe them.',
    ].join('\n');
    try {
      const r = await this.rest.generate(
        this.model(),
        {
          contents: [{ role: 'user', parts: [{ inlineData: { mimeType: frame.mime, data: Buffer.from(frame.data).toString('base64') } }, { text: prompt }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: 'low' }, temperature: 0, maxOutputTokens: 2048 },
        },
        { timeoutMs: 15_000, inputModality: 'IMAGE' },
      );
      const text = r.text.trim();
      if (text.startsWith('NOT_VISIBLE')) return { ok: false, text: text.replace(/^NOT_VISIBLE\s*/, ''), via: 'gemini' };
      return { ok: true, text: text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text, via: 'gemini' };
    } catch (e) {
      log.warn('read_screen failed', e);
      return { ok: false, text: '', via: 'gemini', error: (e as Error).message };
    }
  }
}
