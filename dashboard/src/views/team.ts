/**
 * Team summary bar (§14.1): one chip per person with live agents, tasks in progress and locks held; click (or
 * Enter/Space) to focus that person, and an "N ended" button per person to show their ended agents in the graph.
 * Built from real buttons so it works from the keyboard; elements are reused between updates so focus survives
 * the once-a-second refresh.
 */
import { h, setClass, setText } from '../dom';
import { plural } from '../format';
import type { PersonVM, ViewModel } from '../model';
import type { UiState } from '../team';

export interface TeamBar {
  el: HTMLElement;
  update(vm: ViewModel, ui: UiState): void;
  /** Moves keyboard focus to a person's chip. */
  focusPerson(person: string): void;
}

export interface TeamHandlers {
  onFocus(person: string): void;
  onClear(): void;
  onToggleEnded(person: string): void;
}

interface Row {
  li: HTMLElement;
  main: HTMLButtonElement;
  name: HTMLElement;
  stats: HTMLElement;
  ended: HTMLButtonElement;
}

/** The stats line for one person, e.g. "2 live · 1 in progress · 3 locks". */
export function personStats(p: PersonVM): string {
  return `${p.live} live · ${p.tasksInProgress} in progress · ${plural(p.locks, 'lock')}`;
}

export function createTeamBar(on: TeamHandlers): TeamBar {
  let current: string | null = null;
  const clear = h('button', { type: 'button', class: 'team-clear' }, 'Show everyone');
  clear.addEventListener('click', () => {
    const person = current;
    on.onClear();
    // The button hides itself now; keyboard focus goes to the chip of the person who was focused.
    if (person !== null) rows.get(person)?.main.focus();
  });
  const list = h('ul', { class: 'team-list' });
  const el = h('section', { class: 'team', 'aria-label': 'Team' }, list, clear);
  const rows = new Map<string, Row>();

  function create(person: string): Row {
    const name = h('span', { class: 'team-name' });
    const stats = h('span', { class: 'team-stats' });
    const main = h('button', { type: 'button', class: 'team-main' }, name, stats);
    const ended = h('button', { type: 'button', class: 'team-ended' });
    main.addEventListener('click', () => on.onFocus(person));
    ended.addEventListener('click', () => on.onToggleEnded(person));
    return { li: h('li', { class: 'team-person' }, main, ended), main, name, stats, ended };
  }

  return {
    el,
    update(vm, ui) {
      const people = vm.people;
      el.hidden = people.length === 0;
      const seen = new Set(people.map((p) => p.person));
      for (const [person, row] of rows) {
        if (!seen.has(person)) {
          row.li.remove();
          rows.delete(person);
        }
      }
      people.forEach((p, i) => {
        let row = rows.get(p.person);
        if (!row) {
          row = create(p.person);
          rows.set(p.person, row);
        }
        if (list.children[i] !== row.li) list.insertBefore(row.li, list.children[i] ?? null);
        const focused = ui.focus === p.person;
        setText(row.name, p.person);
        setText(row.stats, personStats(p));
        setClass(row.li, 'focused', focused);
        setClass(row.li, 'dim', ui.focus !== null && !focused);
        setClass(row.li, 'idle', p.live === 0);
        row.main.setAttribute('aria-pressed', String(focused));
        row.main.setAttribute('aria-label', `${p.person}: ${personStats(p)}`);
        // A button that hides itself while it has focus would drop focus to the page; hand it to the chip instead.
        if (p.ended === 0 && document.activeElement === row.ended) row.main.focus();
        row.ended.hidden = p.ended === 0;
        if (p.ended > 0) {
          const open = ui.expanded.has(p.person);
          setText(row.ended, `${p.ended} ended`);
          row.ended.setAttribute('aria-expanded', String(open));
          row.ended.setAttribute('aria-label', `${open ? 'Hide' : 'Show'} ${p.ended} ended ${p.ended === 1 ? 'agent' : 'agents'} of ${p.person}`);
        }
      });
      clear.hidden = ui.focus === null;
      current = ui.focus;
    },
    focusPerson(person) {
      rows.get(person)?.main.focus();
    },
  };
}
