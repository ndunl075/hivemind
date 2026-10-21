import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// happy-dom does no layout, so this guards the CSS rule behind the empty-banners bug: an empty `.banners` is
// `display: none`, so every region must be pinned to its own grid row or the 1fr row lands on the footer.
const css = readFileSync(join(import.meta.dirname, 'styles.css'), 'utf8');

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} rule exists`).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

describe('#app grid rows', () => {
  it('collapses the empty banner strip', () => {
    expect(rule('.banners:empty')).toContain('display: none');
  });

  it.each([
    ['topbar', 1],
    ['banners', 2],
    ['main', 3],
    ['footer', 4],
  ])('pins .%s to row %i', (name, row) => {
    expect(rule(`#app > .${name}`)).toContain(`grid-row: ${row};`);
  });
});
