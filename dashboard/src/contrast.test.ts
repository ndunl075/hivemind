/** WCAG contrast of the text colors against the surfaces they sit on, read from the real stylesheet. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`missing token --${name}`);
  return m[1]!;
}

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const surfaces = ['bg', 'surface', 'raised'];
const texts = ['text', 'text-2', 'muted', 'accent', 'quiet', 'danger'];

describe('text contrast (WCAG AA, 4.5:1)', () => {
  for (const t of texts) {
    for (const s of surfaces) {
      it(`--${t} on --${s}`, () => {
        expect(contrast(token(t), token(s))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('button label on the accent', () => {
    expect(contrast('#0e0e10', token('accent'))).toBeGreaterThanOrEqual(4.5);
  });
  it('focus ring against the page (3:1 for non-text)', () => {
    expect(contrast(token('accent'), token('bg'))).toBeGreaterThanOrEqual(3);
    expect(css).toMatch(/:focus-visible\s*{[^}]*outline:\s*2px solid var\(--accent\)/);
  });
});
