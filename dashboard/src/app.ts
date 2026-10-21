/** Wires the data source to the views. No framework: one render per snapshot, one per second for the clocks. */
import type { Pulse, Snapshot } from '../../shared/contracts';
import { h } from './dom';
import type { LiveSource, SourceOptions } from './live/types';
import { buildViewModel, showReconnectBanner, type CheckoutOrder, type ConnectionState, type ViewModel } from './model';
import { NO_FOCUS, normalizeUi, shapeViewModel, toggleEnded, toggleFocus, type UiState } from './team';
import { forgetToken, saveToken } from './token';
import { createBanners, createFooter, createTokenPrompt, createTopbar, type BannerItem } from './views/chrome';
import { createGraph } from './views/graph';
import { createTeamBar } from './views/team';
import { createActivityPanel, createLocksPanel, createTasksPanel } from './views/panels';

export interface AppDeps {
  createSource(opts: SourceOptions): LiveSource;
  sourceNeedsToken: boolean;
  room: string;
  token: string | null;
  demo: string | null;
  /** Wall clock; replaced in tests. */
  clock?: () => number;
}

export interface App {
  stop(): void;
}

export function mountApp(root: HTMLElement, deps: AppDeps): App {
  const clock = deps.clock ?? Date.now;
  const topbar = createTopbar();
  const banners = createBanners();
  const graph = createGraph();
  const team = createTeamBar({
    onFocus(person) {
      setUi(toggleFocus(ui, person));
    },
    onClear() {
      setUi({ ...ui, focus: null });
    },
    onToggleEnded(person) {
      setUi(toggleEnded(ui, person));
    },
  });
  const tasks = createTasksPanel();
  const locks = createLocksPanel();
  const activity = createActivityPanel();
  const footer = createFooter();
  const prompt = createTokenPrompt((token) => {
    saveToken(deps.room, token);
    token_ = token;
    awaitingToken = false;
    conn = 'connecting';
    since = clock();
    prompt.hide();
    startSource();
  }, { dismissible: deps.demo === 'prompt' });

  const side = h('aside', { class: 'side' }, tasks.el, locks.el, activity.el);
  const main = h('main', { class: 'main' }, graph.el, side);
  root.replaceChildren(topbar.el, banners.el, team.el, main, footer.el, prompt.el);

  let token_ = deps.token;
  let snapshot: Snapshot | null = null;
  let offset = 0;
  let conn: ConnectionState = 'connecting';
  let since = clock();
  let vm: ViewModel | null = null;
  let ui: UiState = NO_FOCUS;
  /** Checkout numbering, kept for this page load so labels don't shift when agents come and go. */
  const checkoutOrder: CheckoutOrder = new Map();
  let stopSource: (() => void) | null = null;
  /** Bumped on every start and on stop, so callbacks from a replaced or stopped source are ignored. */
  let generation = 0;
  let stopped = false;
  /** True while we're waiting for the person to enter a viewer token; suppresses the connecting banner. */
  let awaitingToken = false;

  const nowMs = () => clock() + offset;

  function setUi(next: UiState): void {
    ui = next;
    render();
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !e.defaultPrevented && ui.focus !== null) setUi({ ...ui, focus: null });
  };
  document.addEventListener('keydown', onKey);

  function render(): void {
    const t = clock();
    vm = snapshot ? buildViewModel(snapshot, nowMs(), checkoutOrder) : null;
    if (vm) ui = normalizeUi(ui, vm);
    const items: BannerItem[] = [];
    if (!awaitingToken && showReconnectBanner(conn, since, t)) {
      items.push({ id: 'reconnect', tone: 'warn', text: vm ? 'Reconnecting. Showing the last update received.' : 'Connecting to the room…' });
    }
    if (vm) items.push(...vm.banners);
    topbar.update(vm, conn, deps.room, ui.focus !== null);
    banners.update(items);
    footer.update(vm);
    if (vm) {
      const shown = shapeViewModel(vm, ui);
      team.update(vm, ui);
      graph.update(shown);
      tasks.update(shown);
      locks.update(shown);
      activity.update(shown);
    }
  }

  function startSource(): void {
    stopSource?.();
    stopSource = null;
    const mine = ++generation;
    const current = () => !stopped && mine === generation;
    const stop = deps.createSource({ room: deps.room, token: token_, demo: deps.demo }).start({
      onSnapshot(s) {
        if (!current()) return;
        snapshot = s;
        offset = s.now - clock();
        render();
      },
      onPulse(p: Pulse) {
        if (!current()) return;
        graph.pulse(p);
      },
      onStatus(state) {
        if (!current()) return;
        if (state !== 'open' && conn === 'open') since = clock();
        conn = state;
        render();
      },
      onAuthFailure() {
        // The server keeps refusing the viewer token: stop retrying, forget it, and ask for a new one.
        // Deferred so it also works when a source reports the failure synchronously inside start().
        queueMicrotask(() => {
          if (!current()) return;
          generation += 1; // retire the failing source first, so its own late callbacks are ignored
          stopSource?.();
          stopSource = null;
          if (deps.sourceNeedsToken) forgetToken(deps.room);
          token_ = null;
          awaitingToken = true;
          render();
          prompt.show();
        });
      },
    });
    if (mine === generation) stopSource = stop;
    else stop();
  }

  document.title = `Hivemind · ${deps.room}`;
  if (deps.sourceNeedsToken && !token_) awaitingToken = true;
  if ((deps.sourceNeedsToken && !token_) || deps.demo === 'prompt') prompt.show();
  if (!deps.sourceNeedsToken || token_) startSource();
  render();
  const timer = setInterval(render, 1000);

  return {
    stop() {
      stopped = true;
      generation += 1;
      clearInterval(timer);
      document.removeEventListener('keydown', onKey);
      stopSource?.();
      stopSource = null;
    },
  };
}
