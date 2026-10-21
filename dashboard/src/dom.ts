/**
 * DOM helpers. Agent-supplied text only ever reaches the page through `textContent` / text nodes (§13):
 * no HTML-string sink is used anywhere in the dashboard, and `h` accepts strings only as text.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type Child = string | Node | null | undefined | false;

type Attrs = Record<string, string | number | boolean | null | undefined>;

function apply(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

export function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs?: Attrs, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

/** Sets text only when it changed, so live updates don't churn the DOM. */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setClass(el: Element, name: string, on: boolean): void {
  if (el.classList.contains(name) !== on) el.classList.toggle(name, on);
}

/** Re-renders a region only when its signature changed. */
export function keyed(): { changed(sig: string): boolean } {
  let last: string | null = null;
  return {
    changed(sig) {
      if (sig === last) return false;
      last = sig;
      return true;
    },
  };
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
