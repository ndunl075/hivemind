/** Wires the data source to the views. No framework: one render per snapshot, one per second for the clocks. */
import type { Pulse, Snapshot } from '../../shared/contracts';
import { h } from './dom';
import type { LiveSource, SourceOptions } from './live/types';
import { buildViewModel, showReconnectBanner, type ConnectionState, type ViewModel } from './model';
import { saveToken } from './token';
import { createBanners, createFooter, createTokenPrompt, createTopbar, type BannerItem } from './views/chrome';
import { createGraph } from './views/graph';
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
  const tasks = createTasksPanel();
  const locks = createLocksPanel();
  const activity = createActivityPanel();
  const footer = createFooter();
  const prompt = createTokenPrompt((token) => {
    saveToken(deps.room, token);
    token_ = token;
    prompt.hide();
    startSource();
  }, { dismissible: deps.demo === 'prompt' });

  const side = h('aside', { class: 'side' }, tasks.el, locks.el, activity.el);
  const main = h('main', { class: 'main' }, graph.el, side);
  root.replaceChildren(topbar.el, banners.el, main, footer.el, prompt.el);

  let token_ = deps.token;
  let snapshot: Snapshot | null = null;
  let offset = 0;
  let conn: ConnectionState = 'connecting';
  let since = clock();
  let vm: ViewModel | null = null;
  let stopSource: (() => void) | null = null;

  const nowMs = () => clock() + offset;

  function render(): void {
    const t = clock();
    vm = snapshot ? buildViewModel(snapshot, nowMs()) : null;
    const items: BannerItem[] = [];
    if (showReconnectBanner(conn, since, t)) {
      items.push({ id: 'reconnect', tone: 'warn', text: vm ? 'Reconnecting. Showing the last update received.' : 'Connecting to the room…' });
    }
    if (vm) items.push(...vm.banners);
    topbar.update(vm, conn, deps.room);
    banners.update(items);
    footer.update(vm);
    if (vm) {
      graph.update(vm);
      tasks.update(vm);
      locks.update(vm);
      activity.update(vm);
    }
  }

  function startSource(): void {
    stopSource?.();
    stopSource = deps.createSource({ room: deps.room, token: token_, demo: deps.demo }).start({
      onSnapshot(s) {
        snapshot = s;
        offset = s.now - clock();
        render();
      },
      onPulse(p: Pulse) {
        graph.pulse(p);
      },
      onStatus(state) {
        if (state !== 'open' && conn === 'open') since = clock();
        conn = state;
        render();
      },
      onAuthFailure() {
        // The server keeps refusing the viewer token: stop retrying and ask for a new one.
        stopSource?.();
        stopSource = null;
        prompt.show();
      },
    });
  }

  document.title = `Hivemind · ${deps.room}`;
  if ((deps.sourceNeedsToken && !token_) || deps.demo === 'prompt') prompt.show();
  if (!deps.sourceNeedsToken || token_) startSource();
  render();
  const timer = setInterval(render, 1000);

  return {
    stop() {
      clearInterval(timer);
      stopSource?.();
    },
  };
}
