/**
 * Team focus and ended-agent collapse (ARCHITECTURE.md §14.2, §14.6). Pure: takes the full view-model and what the
 * viewer chose (a focused person, which people have their ended agents expanded) and returns the view-model the
 * graph and panels draw. The topbar, banners and team bar keep using the full view-model so their counts never change.
 */
import type { ViewModel } from './model';

export interface UiState {
  /** The person whose agents, tasks, locks and activity are shown, or null for everyone. */
  focus: string | null;
  /** People whose ended agents are drawn in the graph. */
  expanded: ReadonlySet<string>;
}

export const NO_FOCUS: UiState = { focus: null, expanded: new Set() };

/** A focus on someone who is no longer in the room is dropped. */
export function normalizeUi(ui: UiState, vm: ViewModel): UiState {
  if (ui.focus !== null && !vm.people.some((p) => p.person === ui.focus)) return { ...ui, focus: null };
  return ui;
}

export function toggleFocus(ui: UiState, person: string): UiState {
  return { ...ui, focus: ui.focus === person ? null : person };
}

export function toggleEnded(ui: UiState, person: string): UiState {
  const expanded = new Set(ui.expanded);
  if (!expanded.delete(person)) expanded.add(person);
  return { ...ui, expanded };
}

export function shapeViewModel(vm: ViewModel, ui: UiState): ViewModel {
  const { focus, expanded } = ui;
  const personOf = new Map(vm.agents.map((a) => [a.callsign, a.person]));
  const mine = (callsign: string | null): boolean => focus === null || (callsign !== null && personOf.get(callsign) === focus);

  const agents = vm.agents.filter((a) => (focus === null || a.person === focus) && (a.state !== 'ended' || expanded.has(a.person)));
  const shown = new Set(agents.map((a) => a.callsign));
  const edges = vm.edges.filter((e) => shown.has(e.from) && (e.to === null || shown.has(e.to)));

  if (focus === null) return { ...vm, agents, edges };

  const items = vm.tasks.items.filter((t) => mine(t.owner));
  const hiddenUnowned = vm.tasks.items.filter((t) => t.owner === null && t.status !== 'done').length;
  return {
    ...vm,
    agents,
    edges,
    tasks: {
      open: items.filter((t) => t.status === 'open').length,
      inProgress: items.filter((t) => t.status === 'in_progress').length,
      done: items.filter((t) => t.status === 'done').length,
      items,
      hiddenUnowned,
    },
    locks: vm.locks.filter((l) => mine(l.holder)),
    activity: vm.activity.filter((a) => mine(a.actor)),
  };
}
