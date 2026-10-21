/** Top bar, banners, footer usage and the token prompt. */
import { h, keyed, setClass, setText } from '../dom';
import { formatCount, percent, plural } from '../format';
import type { ConnectionState, ViewModel } from '../model';
import { looksLikeViewerToken, tokenFromFragment } from '../token';

export interface Topbar {
  el: HTMLElement;
  update(vm: ViewModel | null, conn: ConnectionState, room: string): void;
}

export function createTopbar(): Topbar {
  const room = h('span', { class: 'room' });
  const live = h('span', { class: 'live-label' });
  const liveWrap = h('span', { class: 'live' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), live);
  const mode = h('span', { class: 'chip chip-mode' });
  const counts = h('span', { class: 'counts' });
  const el = h(
    'header',
    { class: 'topbar' },
    h('img', { class: 'logo', src: '/logo.svg', alt: '', width: 28, height: 28 }),
    h('h1', { class: 'brand' }, 'Hivemind'),
    h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
    room,
    h('div', { class: 'topbar-right' }, liveWrap, mode, counts),
  );
  return {
    el,
    update(vm, conn, roomName) {
      setText(room, vm?.room ?? roomName);
      setText(live, conn === 'open' ? 'Live' : conn === 'connecting' ? 'Connecting' : 'Offline');
      liveWrap.className = `live conn-${conn}`;
      setText(mode, vm ? `mode: ${vm.mode}` : 'mode: -');
      mode.className = `chip chip-mode mode-${vm?.mode ?? 'none'}`;
      setText(
        counts,
        vm ? `${plural(vm.counts.agents, 'agent')} · ${plural(vm.counts.tasks, 'task')} · ${plural(vm.counts.locks, 'lock')}` : '',
      );
    },
  };
}

export interface BannerItem {
  id: string;
  tone: 'warn' | 'danger';
  text: string;
}

export interface Banners {
  el: HTMLElement;
  update(items: BannerItem[]): void;
}

export function createBanners(): Banners {
  const el = h('div', { class: 'banners', role: 'region', 'aria-label': 'Alerts', 'aria-live': 'polite' });
  const gate = keyed();
  return {
    el,
    update(items) {
      if (!gate.changed(JSON.stringify(items))) return;
      el.replaceChildren(
        ...items.map((b) => h('div', { class: `banner banner-${b.tone}`, 'data-banner': b.id }, h('span', { class: 'banner-mark', 'aria-hidden': 'true' }, '!'), h('span', undefined, b.text))),
      );
    },
  };
}

export interface Footer {
  el: HTMLElement;
  update(vm: ViewModel | null): void;
}

export function createFooter(): Footer {
  const text = h('span', { class: 'usage-text' });
  const pct = h('span', { class: 'usage-pct' });
  const fill = h('span', { class: 'usage-fill' });
  const bar = h('span', { class: 'usage-bar', role: 'progressbar', 'aria-label': 'Requests used today', 'aria-valuemin': 0, 'aria-valuemax': 100 }, fill);
  const el = h('footer', { class: 'footer' }, h('span', { class: 'usage-title' }, 'Free-tier usage today'), bar, text, pct);
  return {
    el,
    update(vm) {
      if (!vm) return;
      const p = percent(vm.usage.requests, vm.usage.cap);
      setText(text, `${formatCount(vm.usage.requests)} of ${formatCount(vm.usage.cap)} requests`);
      setText(pct, `${p}%`);
      fill.style.width = `${p}%`;
      bar.setAttribute('aria-valuenow', String(p));
      el.className = `footer usage-${vm.usage.level}`;
    },
  };
}

export interface TokenPrompt {
  el: HTMLElement;
  show(): void;
  hide(): void;
}

/** The only input on the page. Accepts a bare token or a full dashboard link containing #v=. */
export function createTokenPrompt(onToken: (token: string) => void, options: { dismissible?: boolean } = {}): TokenPrompt {
  const input = h('input', {
    id: 'viewer-token',
    class: 'input',
    type: 'password',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'hm_v.…',
    required: true,
  });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const form = h(
    'form',
    { class: 'token-card', novalidate: true },
    h('img', { class: 'token-logo', src: '/logo.svg', alt: '', width: 40, height: 40 }),
    h('h2', { id: 'token-title' }, 'Enter the viewer token'),
    h('p', { class: 'token-help' }, 'Open the dashboard link your admin shared, or paste its token here. It stays in this browser.'),
    h('label', { for: 'viewer-token', class: 'label' }, 'Viewer token'),
    input,
    error,
    h('button', { class: 'button', type: 'submit' }, 'Connect'),
  );
  const el = h('div', { class: 'token-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'token-title', hidden: true }, form);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const raw = input.value.trim();
    const hashAt = raw.indexOf('#');
    const token = (hashAt >= 0 ? tokenFromFragment(raw.slice(hashAt)) : raw) ?? '';
    if (!looksLikeViewerToken(token)) {
      setText(error, 'That does not look like a viewer token. It starts with hm_v.');
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    setText(error, '');
    input.value = '';
    onToken(token.trim());
  });
  let restore: HTMLElement | null = null;
  const inerted: Element[] = [];

  function hide(): void {
    el.hidden = true;
    setClass(el, 'open', false);
    for (const n of inerted.splice(0)) n.removeAttribute('inert');
    restore?.focus();
    restore = null;
  }

  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && options.dismissible) {
      ev.preventDefault();
      hide();
      return;
    }
    if (ev.key !== 'Tab') return;
    // Keep Tab inside the dialog.
    const stops = [...el.querySelectorAll<HTMLElement>('input, button')];
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (ev.shiftKey && (active === first || !el.contains(active))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (active === last || !el.contains(active))) {
      ev.preventDefault();
      first.focus();
    }
  });

  return {
    el,
    show() {
      restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      el.hidden = false;
      setClass(el, 'open', true);
      // Make everything behind the dialog inert, so focus and clicks cannot reach it.
      for (const sib of Array.from(el.parentElement?.children ?? [])) {
        if (sib !== el && !sib.hasAttribute('inert')) {
          sib.setAttribute('inert', '');
          inerted.push(sib);
        }
      }
      input.focus();
    },
    hide,
  };
}
