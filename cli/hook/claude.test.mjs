// @ts-nocheck -- tests use loosely typed fixtures and a fake server; the code under test is type-checked.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { format, parse } from './claude.mjs';

const FIXTURES = new URL('../../shared/fixtures/hooks/claude/', import.meta.url);
const dir = (rel = '') => new URL(rel, FIXTURES);
const read = (rel) => JSON.parse(readFileSync(new URL(rel, FIXTURES), 'utf8'));

describe('claude parse: every recorded input fixture', () => {
  const inputs = readdirSync(dir()).filter((f) => f.endsWith('.json'));
  it('finds the fixtures', () => expect(inputs.length).toBeGreaterThan(20));

  for (const f of inputs) {
    it(f, () => {
      const raw = read(f);
      const p = parse(raw);
      expect(p.event).toBe(raw.hook_event_name);
      expect(p.session).toBe(raw.session_id);
      expect(p.tool).toBe(raw.tool_name ?? null);
      const isEdit = ['Edit', 'Write', 'NotebookEdit'].includes(raw.tool_name);
      expect(p.editPaths).toEqual(isEdit ? [raw.tool_input.file_path ?? raw.tool_input.notebook_path] : []);
      expect(p.isShell).toBe(['Bash', 'PowerShell'].includes(raw.tool_name));
      expect(p.isHivemindTool).toBe(String(raw.tool_name).startsWith('mcp__hivemind__'));
      expect(p.me).toBe(p.isHivemindTool ? raw.tool_input.me : null);
      expect(p.stopActive).toBe(raw.stop_hook_active === true);
      expect(p.endReason).toBe(raw.reason ?? null);
    });
  }

  it('treats MultiEdit like Edit and ignores agent_id (subagent events are the parent session)', () => {
    const p = parse({ session_id: 's', cwd: '/x', hook_event_name: 'PreToolUse', tool_name: 'MultiEdit', tool_input: { file_path: '/x/a' }, agent_id: 'sub-1' });
    expect(p.editPaths).toEqual(['/x/a']);
    expect(p.session).toBe('s');
  });

  it('rejects payloads without a session', () => {
    expect(() => parse({ hook_event_name: 'Stop' })).toThrow();
    expect(() => parse('nope')).toThrow();
  });
});

describe('claude format: exact output for every output fixture', () => {
  /** case name -> [event, outcome]; the output must equal the recorded stdout byte for byte. */
  const emitted = {
    'PostToolUse.additionalContext': ['PostToolUse', { decision: 'allow', reason: null, context: '<context>' }],
    'PreToolUse.additionalContext': ['PreToolUse', { decision: 'allow', reason: null, context: '<context>' }],
    'PreToolUse.deny': ['PreToolUse', { decision: 'deny', reason: '<reason>', context: null }],
    'PreToolUse.deny-with-context': ['PreToolUse', { decision: 'deny', reason: '<reason>', context: '<context>' }],
    'SessionStart.additionalContext': ['SessionStart', { decision: 'allow', reason: null, context: '<briefing>' }],
    'Stop.block': ['Stop', { decision: 'block', reason: '<direct-message>', context: null }],
    'UserPromptSubmit.additionalContext': ['UserPromptSubmit', { decision: 'allow', reason: null, context: '<unread-messages>' }],
  };
  /** Recorded to show what Claude tolerates; Hivemind never emits these shapes. */
  const notEmitted = [
    'PostToolUse.block-with-context', 'PostToolUse.unknown-inner-field', 'PreToolUse.allow-with-unknown-fields',
    'PreToolUse.exit1', 'PreToolUse.exit2', 'PreToolUse.invalid-json', 'PreToolUse.timeout',
  ];
  const cases = readdirSync(dir('output/')).map((f) => f.replace(/\.json$/, ''));

  it('covers every fixture (a new one must be classified)', () => {
    expect(cases.filter((c) => !(c in emitted) && !notEmitted.includes(c))).toEqual([]);
  });

  for (const [name, [event, outcome]] of Object.entries(emitted)) {
    it(name, () => {
      const fx = read(`output/${name}.json`);
      expect(fx.event).toBe(event);
      expect(fx.verdict).toBe('accepted');
      expect(format(event, outcome)).toBe(fx.stdout);
    });
  }

  it('prints nothing when there is nothing to say', () => {
    expect(format('PreToolUse', { decision: 'allow', reason: null, context: null })).toBeNull();
    expect(format('PostToolUse', { decision: 'allow', reason: null, context: '' })).toBeNull();
    expect(format('Stop', { decision: 'allow', reason: null, context: 'x' })).toBeNull();
    expect(format('Stop', { decision: 'block', reason: null, context: null })).toBeNull();
    expect(format('SessionEnd', { decision: 'allow', reason: null, context: 'x' })).toBeNull();
  });

  it('gives a deny without a reason a default one', () => {
    const out = JSON.parse(format('PreToolUse', { decision: 'deny', reason: null, context: null }));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Hivemind');
  });
});
