/** Tasks, Locks and Activity panels (§14.3). Every string from an agent is set as a text node. */
import type { AgentState } from '../../../shared/contracts';
import { h, keyed, setText } from '../dom';
import { plural } from '../format';
import type { ViewModel } from '../model';

export interface Panel {
  el: HTMLElement;
  update(vm: ViewModel): void;
}

function panel(title: string, label: string): { el: HTMLElement; meta: HTMLElement; body: HTMLElement } {
  const meta = h('div', { class: 'panel-meta' });
  const body = h('div', { class: 'panel-body', tabindex: 0, role: 'region', 'aria-label': label });
  const el = h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', undefined, title), meta), body);
  return { el, meta, body };
}

function chip(name: string, state: AgentState | null): HTMLElement {
  return h('span', { class: `chip chip-owner${state ? ` st-${state}` : ''}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), name);
}

const STATUS_LABEL = { open: 'open', in_progress: 'in progress', done: 'done', dropped: 'dropped' } as const;

export function createTasksPanel(): Panel {
  const { el, meta, body } = panel('Tasks', 'Tasks');
  const gate = keyed();
  return {
    el,
    update(vm) {
      if (!gate.changed(JSON.stringify(vm.tasks))) return;
      meta.replaceChildren(
        h('span', { class: 'stat' }, h('b', undefined, String(vm.tasks.open)), ' open'),
        h('span', { class: 'stat' }, h('b', undefined, String(vm.tasks.inProgress)), ' in progress'),
        h('span', { class: 'stat' }, h('b', undefined, String(vm.tasks.done)), ' done'),
      );
      if (vm.tasks.hiddenUnowned > 0) meta.append(h('span', { class: 'stat stat-hint' }, `${plural(vm.tasks.hiddenUnowned, 'unowned task')} hidden`));
      const rows = vm.tasks.items.map((t) =>
        h(
          'article',
          { class: `row task-row status-${t.status}` },
          h('span', { class: 'task-id' }, `#${t.id}`),
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-title' }, t.title),
            h(
              'div',
              { class: 'row-meta' },
              t.owner ? chip(t.owner, t.ownerState) : h('span', { class: 'chip chip-plain' }, 'unowned'),
              h('span', { class: `chip chip-status s-${t.status}` }, STATUS_LABEL[t.status]),
              t.waitingOn.length > 0 ? h('span', { class: 'chip chip-wait' }, `waits on ${t.waitingOn.map((i) => `#${i}`).join(', ')}`) : null,
            ),
            t.note ? h('div', { class: 'row-note' }, t.note) : null,
          ),
        ),
      );
      body.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, 'No tasks yet.')]));
    },
  };
}

export function createLocksPanel(): Panel {
  const { el, meta, body } = panel('Locks', 'Locks');
  const gate = keyed();
  return {
    el,
    update(vm) {
      if (!gate.changed(JSON.stringify(vm.locks))) return;
      meta.replaceChildren(h('span', { class: 'stat' }, h('b', undefined, String(vm.locks.length)), ' held'));
      const rows = vm.locks.map((l) =>
        h(
          'article',
          { class: `row lock-row${l.takeable ? ' takeable' : ''}` },
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-path' }, l.path),
            h(
              'div',
              { class: 'row-meta' },
              chip(l.holder, l.holderState),
              h('span', { class: 'chip chip-plain' }, l.kind),
              l.takeable ? h('span', { class: 'chip chip-takeable' }, 'takeable') : null,
            ),
          ),
        ),
      );
      body.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, 'Nothing is locked.')]));
    },
  };
}

export function createActivityPanel(): Panel {
  const { el, meta, body } = panel('Activity', 'Activity');
  const gate = keyed();
  let ages: { el: HTMLElement; seq: number }[] = [];
  return {
    el,
    update(vm) {
      // Rebuild only when the set of items changes; ages are updated in place.
      if (gate.changed(JSON.stringify(vm.activity.map((a) => [a.seq, a.type, a.tone, a.text])))) {
        meta.replaceChildren(h('span', { class: 'stat' }, 'newest first'));
        ages = [];
        const rows = vm.activity.map((a) => {
          const age = h('div', { class: 'act-age' }, a.age);
          ages.push({ el: age, seq: a.seq });
          return h(
            'article',
            { class: `row act-row tone-${a.tone}` },
            h('span', { class: 'act-dot', 'aria-hidden': 'true' }),
            h('div', { class: 'row-main' }, h('div', { class: 'act-text' }, a.text), age),
          );
        });
        body.replaceChildren(...(rows.length ? rows : [h('p', { class: 'empty' }, 'Quiet so far.')]));
        return;
      }
      const bySeq = new Map(vm.activity.map((a) => [a.seq, a.age]));
      for (const a of ages) setText(a.el, bySeq.get(a.seq) ?? '');
    },
  };
}
