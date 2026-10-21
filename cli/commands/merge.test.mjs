// @ts-nocheck -- tests use loosely typed fixtures.
/** Unit tests for the config editors: no files, no network, no ports. */
import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { codexMcpBlock, hasOurBlock, readBlock, removeBlock, setBlock } from './codex-config.mjs';
import { mergeHooks, oursMatcher, removeHooks } from './hooks-merge.mjs';
import { MD_END, MD_START, removeSection, setSection } from './markers.mjs';
import {
  CLAUDE_SPECS, CODEX_SPECS, addJsonCommands, claudeHandler, codexHandler, headersHelperCommand, helperCmdText, isOurHelper, posixQuote,
  powershellQuote, shellWord,
} from './registrations.mjs';
import { looksLikeAgentToken, normalizeServer } from './api.mjs';
import { parseArgs } from './args.mjs';

const NODE = '/usr/bin/node';
const HOOK = '/home/me/.hivemind/hook/hook.mjs';
const TOKEN = 'hm_a.test.ana.1.AAAAAAAAAAAAAAAA';

describe('hooks-merge', () => {
  const isOurs = oursMatcher(HOOK);
  const make = (spec) => claudeHandler(NODE, HOOK, spec);

  it('recognises our handlers by script path, in command, args and commandWindows', () => {
    expect(isOurs({ command: NODE, args: [HOOK, 'claude'] })).toBe(true);
    expect(isOurs({ command: `"${NODE}" "${HOOK}" codex` })).toBe(true);
    const win = oursMatcher('C:\\Users\\me\\.hivemind\\hook\\hook.mjs');
    expect(win({ command: 'x', commandWindows: '& "C:\\Users\\me\\.hivemind\\hook\\hook.mjs" codex' })).toBe(true);
    expect(isOurs({ command: 'other.sh' })).toBe(false);
    expect(isOurs({ command: '/opt/tool/hook.mjs' })).toBe(false);
    expect(isOurs(null)).toBe(false);
    expect(isOurs('str')).toBe(false);
  });

  it('matches only our own hook path, as a whole word', () => {
    // Some other folder's hivemind hook, a longer path that starts with ours, and a suffix are not ours.
    expect(isOurs({ command: '"/usr/bin/node" "/home/other/.hivemind/hook/hook.mjs" codex' })).toBe(false);
    expect(isOurs({ command: `"${NODE}" "${HOOK}.bak" codex` })).toBe(false);
    expect(isOurs({ command: `"${NODE}" "/x${HOOK}" codex` })).toBe(false);
    expect(isOurs({ command: NODE, args: [`${HOOK}x`, 'claude'] })).toBe(false);
    expect(isOurs({ command: `"${NODE}" "${HOOK}" codex` })).toBe(true);
    // The escaped forms the registrations write for odd characters still match.
    const odd = '/home/we ird/$x/.hivemind/hook/hook.mjs';
    expect(oursMatcher(odd)(codexHandler(NODE, odd, { timeout: 5 }))).toBe(true);
  });

  it('on update, takes our stale handlers out of events the specs no longer list, and keeps the user\'s', () => {
    const stale = { hooks: {
      Notification: [{ hooks: [make({ timeout: 5 })] }],
      PreCompact: [{ hooks: [make({ timeout: 5 }), { command: 'theirs' }] }],
      Other: [{ hooks: [{ command: 'x' }] }],
    } };
    const out = mergeHooks(stale, CLAUDE_SPECS, make, isOurs);
    expect(out.hooks.Notification).toBeUndefined();
    expect(out.hooks.PreCompact).toEqual([{ hooks: [{ command: 'theirs' }] }]);
    expect(out.hooks.Other).toEqual(stale.hooks.Other);
    expect(Object.keys(out.hooks).sort()).toEqual(['Other', 'PostToolUse', 'PreCompact', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  });

  it('adds our groups and keeps everything else, in order', () => {
    const root = { a: 1, hooks: { Stop: [{ hooks: [{ command: 'one' }] }], Other: [{ hooks: [{ command: 'x' }] }] } };
    const out = mergeHooks(root, CLAUDE_SPECS, make, isOurs);
    expect(out.a).toBe(1);
    expect(out.hooks.Other).toEqual(root.hooks.Other);
    expect(out.hooks.Stop[0]).toEqual(root.hooks.Stop[0]);
    expect(out.hooks.Stop).toHaveLength(2);
    expect(root.hooks.Stop).toHaveLength(1);
  });

  it('is idempotent and replaces in place, even when a group mixes ours with another handler', () => {
    const mixed = { hooks: { Stop: [{ hooks: [make({ timeout: 5 }), { command: 'mine' }] }, { hooks: [{ command: 'later' }] }] } };
    const once = mergeHooks(mixed, CLAUDE_SPECS, make, isOurs);
    const twice = mergeHooks(once, CLAUDE_SPECS, make, isOurs);
    expect(twice).toEqual(once);
    expect(once.hooks.Stop.map((g) => g.hooks.map((h) => h.command))).toEqual([[NODE], ['mine'], ['later']]);
  });

  it('updates a changed node path in place without duplicating', () => {
    const first = mergeHooks({}, CLAUDE_SPECS, make, isOurs);
    const moved = mergeHooks(first, CLAUDE_SPECS, (s) => claudeHandler('/new/node', HOOK, s), isOurs);
    expect(moved.hooks.SessionStart).toHaveLength(1);
    expect(moved.hooks.SessionStart[0].hooks[0].command).toBe('/new/node');
  });

  it('removeHooks takes out only ours and prunes what it emptied', () => {
    const root = { hooks: { Stop: [{ hooks: [{ command: 'one' }] }] } };
    const merged = mergeHooks(root, CLAUDE_SPECS, make, isOurs);
    expect(removeHooks(merged, isOurs)).toEqual(root);
    expect(removeHooks(mergeHooks({}, CLAUDE_SPECS, make, isOurs), isOurs)).toEqual({});
    const mixed = { hooks: { Stop: [{ matcher: 'm', hooks: [make({ timeout: 5 }), { command: 'mine' }] }] } };
    expect(removeHooks(mixed, isOurs)).toEqual({ hooks: { Stop: [{ matcher: 'm', hooks: [{ command: 'mine' }] }] } });
  });

  it('refuses shapes it does not understand instead of rewriting them', () => {
    expect(() => mergeHooks({ hooks: [] }, CLAUDE_SPECS, make, isOurs)).toThrow('not an object');
    expect(() => mergeHooks({ hooks: { Stop: 'x' } }, CLAUDE_SPECS, make, isOurs)).toThrow('not a list');
  });

  it('keeps entries it cannot classify', () => {
    const odd = { hooks: { Stop: ['weird', { hooks: 'nope' }, { hooks: [{ command: 'k' }] }] } };
    const out = mergeHooks(odd, CLAUDE_SPECS, make, isOurs);
    expect(out.hooks.Stop.slice(0, 3)).toEqual(odd.hooks.Stop);
    expect(removeHooks(out, isOurs)).toEqual(odd);
  });
});

describe('registrations', () => {
  it('Claude: command and args, no shell', () => {
    expect(claudeHandler(NODE, HOOK, { timeout: 3 })).toEqual({ type: 'command', command: NODE, args: [HOOK, 'claude'], timeout: 3 });
  });

  it('Claude events, matchers and timeouts follow ARCHITECTURE.md 6.2', () => {
    expect(CLAUDE_SPECS.map((s) => [s.event, s.matcher ?? null, s.timeout])).toEqual([
      ['SessionStart', null, 5], ['UserPromptSubmit', null, 5],
      ['PreToolUse', 'Edit|Write|MultiEdit|NotebookEdit|mcp__hivemind__.*', 5],
      ['PostToolUse', '.*', 5], ['Stop', null, 5], ['SessionEnd', null, 3],
    ]);
  });

  it('Codex events, matchers and timeouts follow ARCHITECTURE.md 6.2 and the spike', () => {
    expect(CODEX_SPECS.map((s) => [s.event, s.matcher ?? null, s.timeout])).toEqual([
      ['SessionStart', null, 5], ['UserPromptSubmit', null, 5],
      ['PreToolUse', 'apply_patch|Edit|Write|mcp__hivemind__.*', 5],
      ['PostToolUse', 'Bash|apply_patch', 5], ['Stop', null, 5], ['SessionEnd', null, 3],
    ]);
  });

  it('Codex: POSIX command and the exact PowerShell form', () => {
    const h = codexHandler('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me\\.hivemind\\hook\\hook.mjs', { timeout: 5 });
    expect(h.commandWindows).toBe('& "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\.hivemind\\hook\\hook.mjs" codex; exit $LASTEXITCODE');
    expect(Object.keys(h)).toEqual(['type', 'command', 'commandWindows', 'timeout']);
    expect(codexHandler(NODE, HOOK, { timeout: 5 }).command).toBe(`"${NODE}" "${HOOK}" codex`);
  });

  it('quotes shell metacharacters and refuses line breaks', () => {
    expect(posixQuote('/a b/$x`y"z\\w')).toBe('"/a b/\\$x\\`y\\"z\\\\w"');
    expect(powershellQuote('C:\\a b\\$x`y"z')).toBe('"C:\\a b\\`$x``y`"z"');
    expect(() => posixQuote('a\nb')).toThrow('line break');
    expect(() => powershellQuote('a\r\nb')).toThrow('line break');
  });

  it('headers helper: POSIX quotes node and script; Windows points at the wrapper as one shell word', () => {
    expect(headersHelperCommand('linux', '/opt/node js/bin/node', '/home/me/.hivemind/hook/headers-helper.mjs', '/x/headers-helper.cmd'))
      .toBe('"/opt/node js/bin/node" "/home/me/.hivemind/hook/headers-helper.mjs"');
    const win = headersHelperCommand('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me\\.hivemind\\hook\\headers-helper.mjs', 'C:\\Users\\me\\.hivemind\\hook\\headers-helper.cmd');
    expect(win).toBe('C:/Users/me/.hivemind/hook/headers-helper.cmd');
    expect(headersHelperCommand('win32', 'n', 's', 'C:\\Users\\Ann Lee\\.hivemind\\hook\\headers-helper.cmd'))
      .toBe('C:/Users/Ann" "Lee/.hivemind/hook/headers-helper.cmd');
    const mine = 'C:\\Users\\me\\.hivemind\\hook\\headers-helper.cmd';
    expect(isOurHelper(win, mine)).toBe(true);
    expect(isOurHelper('"/a/b/.hivemind/hook/headers-helper.mjs"', '/a/b/.hivemind/hook/headers-helper.mjs')).toBe(true);
    expect(isOurHelper('C:/Users/Ann" "Lee/.hivemind/hook/headers-helper.cmd', 'C:\\Users\\Ann Lee\\.hivemind\\hook\\headers-helper.cmd')).toBe(true);
    // Same file name in another folder, a longer name, or nothing: not ours.
    expect(isOurHelper('"/other/.hivemind/hook/headers-helper.mjs"', '/a/b/.hivemind/hook/headers-helper.mjs')).toBe(false);
    expect(isOurHelper('/a/b/.hivemind/hook/headers-helper.mjs.bak', '/a/b/.hivemind/hook/headers-helper.mjs')).toBe(false);
    expect(isOurHelper('node other-helper.js', mine)).toBe(false);
    expect(isOurHelper(win)).toBe(false);
  });

  it('shellWord refuses characters one of the shells would act on', () => {
    for (const bad of ['C:/a&b/x.cmd', 'C:/a(b)/x.cmd', "C:/it's/x.cmd", 'C:/a$b/x.cmd', 'C:/100%/x.cmd', 'C:/a`b/x.cmd', 'C:/a;b/x.cmd', 'C:/a"b/x.cmd']) {
      expect(() => shellWord(bad), bad).toThrow('HIVEMIND_HOME');
    }
    expect(shellWord('C:\\Users\\ünï user\\.hivemind\\x.cmd')).toBe('C:/Users/ünï" "user/.hivemind/x.cmd');
  });

  it('the Windows wrapper runs the recorded node on the script next to it', () => {
    expect(helperCmdText('C:\\Program Files\\nodejs\\node.exe')).toBe('@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "%~dp0headers-helper.mjs"\r\n');
    expect(helperCmdText('C:\\100%\\node.exe')).toContain('"C:\\100%%\\node.exe"');
    expect(() => helperCmdText('C:\\a"b\\node.exe')).toThrow();
  });

  it('the hand-run fallback is quoted per shell family', () => {
    const json = JSON.stringify({ type: 'http', url: 'https://h.example.com/mcp', headersHelper: 'C:/Ann" "Lee/h.cmd' });
    const posix = addJsonCommands('linux', json);
    expect(posix).toHaveLength(1);
    expect(posix[0].command).toBe(`claude mcp add-json --scope user hivemind '${json}'`);
    const win = addJsonCommands('win32', json);
    expect(win.map((c) => c.shell)).toEqual(['PowerShell', 'Command Prompt']);
    // No POSIX single-quote form on Windows, and every double quote is escaped for the Windows argument parser.
    expect(win[1].command.startsWith('claude mcp add-json --scope user hivemind "{')).toBe(true);
    expect(win[0].command.startsWith("claude mcp add-json --scope user hivemind '{")).toBe(true);
    expect(win[0].command).toContain('\\"type\\"');
  });
});

describe('codex config.toml block', () => {
  const block = codexMcpBlock('https://hive.example.com', TOKEN);

  it('reads back as the table Codex needs', () => {
    const t = parse(block).mcp_servers.hivemind;
    expect(t).toEqual({
      url: 'https://hive.example.com/mcp',
      http_headers: { Authorization: `Bearer ${TOKEN}` },
      default_tools_approval_mode: 'approve',
      tool_timeout_sec: 60,
    });
  });

  it('goes before the first table header, keeps everything else byte for byte, and removes cleanly', () => {
    for (const original of ['', 'a = 1\n', 'a = 1', '# c\n[x]\ny = 2\n', 'a = 1\n[x]\ny = 2\n', 'a = 1\n\n[x]\ny = 2\n\n[[z]]\nq = 1\n', '[mcp_servers.other]\ncommand = "x"\n', 'a = 1\r\n\r\n[x]\r\ny = 2\r\n']) {
      const added = setBlock(original === '' ? null : original, block, 'f');
      expect(hasOurBlock(added)).toBe(true);
      const t = parse(added);
      expect(t.mcp_servers.hivemind.url).toBe('https://hive.example.com/mcp');
      expect({ ...t, mcp_servers: undefined }).toEqual({ ...parse(original || ''), mcp_servers: undefined });
      const header = /^[ \t]*\[/m.exec(original);
      if (header) {
        // The block comes before the first header; the original text before and after it is untouched.
        const at = added.indexOf('# hivemind:start');
        expect(at).toBe(header.index);
        expect(added.slice(0, at)).toBe(original.slice(0, header.index));
        expect(added.endsWith(original.slice(header.index))).toBe(true);
      } else {
        expect(added.startsWith(original)).toBe(true);
      }
      if (original.includes('\r\n')) expect(added.replace(/\r\n/g, '')).not.toContain('\n');
      const removed = removeBlock(added, 'f');
      expect(removed === original || removed === `${original}\n`, JSON.stringify(removed)).toBe(true);
      expect(parse(removed || '')).toEqual(parse(original || ''));
    }
  });

  it('a root key appended to the file later does not land in our table', () => {
    const added = setBlock('model = "x"\n\n[tools]\nweb = true\n', block, 'f');
    const later = parse(`${added}\nextra = 1\n`);
    expect(later.mcp_servers.hivemind.extra).toBeUndefined();
    expect(later.tools.extra).toBe(1); // the user's own last table, as TOML says
    // And with the root keys above the block, not below it:
    expect(added.indexOf('model = "x"')).toBeLessThan(added.indexOf('# hivemind:start'));
  });

  it('does not mistake a header-looking line inside a string or an array for a table', () => {
    const inString = 's = """\n[fake]\ntext\n"""\n\n[real]\nx = 1\n';
    const a = setBlock(inString, block, 'f');
    expect(parse(a).s).toBe('[fake]\ntext\n');
    expect(a.indexOf('# hivemind:start')).toBeGreaterThan(a.indexOf('"""\n\n'));
    expect(a.indexOf('# hivemind:start')).toBeLessThan(a.indexOf('[real]'));
    const inArray = 'x = [\n  [1, 2],\n  [3],\n]\n';
    const b = setBlock(inArray, block, 'f');
    expect(parse(b).x).toEqual([[1, 2], [3]]);
    expect(b.startsWith(inArray)).toBe(true);
    expect(removeBlock(b, 'f')).toBe(inArray);
  });

  it('refreshing the block is idempotent and swaps only the block', () => {
    const original = 'a = 1\n\n[b]\nc = 2\n';
    const once = setBlock(original, block, 'f');
    expect(setBlock(once, block, 'f')).toBe(once);
    const other = codexMcpBlock('https://other.example.com', 'hm_a.test.ben.1.BBBBBBBBBBBBBBBB');
    const swapped = setBlock(once, other, 'f');
    expect(removeBlock(swapped, 'f')).toBe(original);
    expect(parse(swapped).mcp_servers.hivemind.url).toBe('https://other.example.com/mcp');
    expect(swapped.match(/hivemind:start/g)).toHaveLength(1);
  });

  it('removal takes only the exact lines it owns and refuses anything else', () => {
    const original = 'a = 1\n\n[b]\nc = 2\n';
    const added = setBlock(original, block, 'f');
    // A key the user typed inside the markers: not exactly our table.
    const edited = added.replace('tool_timeout_sec = 60', 'tool_timeout_sec = 60\nmy_key = 1');
    expect(() => removeBlock(edited, 'f')).toThrow('edited');
    // Our table with a different table pasted between the markers.
    expect(() => removeBlock(added.replace('tool_timeout_sec = 60', 'tool_timeout_sec = 60\n[other]\nz = 1'), 'f')).toThrow('edited');
    // Text appended after our end marker belongs to our table as far as TOML is concerned: removing the block
    // would move it to another table, so removal stops.
    const appended = `${setBlock('a = 1\n', block, 'f')}extra = 5\n`;
    expect(parse(appended).mcp_servers.hivemind.extra).toBe(5);
    expect(() => removeBlock(appended, 'f')).toThrow('would change other settings');
    // Markers without a partner, or twice.
    expect(() => removeBlock(added.replace('# hivemind:end', '# nothing'), 'f')).toThrow('marker');
    expect(() => removeBlock(`${added}\n${added}`, 'f')).toThrow('marker');
    expect(() => setBlock(added.replace('# hivemind:end', '# nothing'), block, 'f')).toThrow('marker');
    // Nothing of ours: unchanged.
    expect(removeBlock(original, 'f')).toBe(original);
  });

  it('TOML errors name a line, never quote the file', () => {
    let msg = '';
    try { setBlock('quoted_name = = 1\n', block, '/h/config.toml'); } catch (e) { msg = e.message; }
    expect(msg).toContain('not valid TOML');
    expect(msg).toContain('/h/config.toml');
    expect(msg).toMatch(/line \d+/);
    expect(msg).not.toContain('quoted_name');
  });

  it('refuses a hand-written hivemind table and broken TOML', () => {
    expect(() => setBlock('[mcp_servers.hivemind]\nurl = "x"\n', block, 'f')).toThrow('its own');
    expect(() => setBlock('mcp_servers = { hivemind = { url = "x" } }\n', block, 'f')).toThrow();
    expect(() => setBlock('a = = 1\n', block, 'f')).toThrow('not valid TOML');
  });

  it('refuses a token it cannot put in TOML safely', () => {
    expect(() => codexMcpBlock('https://h.example.com', 'hm_a.x"y')).toThrow();
    expect(() => codexMcpBlock('https://h.example.com', 'not-a-token')).toThrow();
  });

  it('readBlock reports what doctor needs', () => {
    expect(readBlock(`a = 1\n\n${block}\n`)).toEqual({ url: 'https://hive.example.com/mcp', hasAuth: true, approve: true, timeout: 60 });
    expect(readBlock('a = 1\n')).toBeNull();
  });
});

describe('markers', () => {
  const proto = '## Hivemind\n- rule one\n- rule two';

  it('adds the section, leaves the rest alone, is idempotent, and removes cleanly', () => {
    for (const original of ['', '# Title\n', '# Title', 'text\n\nmore\n']) {
      const once = setSection(original === '' ? null : original, proto);
      expect(once.startsWith(original)).toBe(true);
      expect(once).toContain(`${MD_START}\n${proto}\n${MD_END}`);
      expect(setSection(once, proto)).toBe(once);
      const removed = removeSection(once);
      expect(removed === original || removed === `${original}\n`).toBe(true);
    }
  });

  it('replaces changed text between the markers and nothing around it', () => {
    const doc = `before\n\n${MD_START}\nold text\n${MD_END}\n\nafter\n`;
    const out = setSection(doc, proto);
    expect(out).toBe(`before\n\n${MD_START}\n${proto}\n${MD_END}\n\nafter\n`);
  });

  it('stops on a lone marker instead of guessing', () => {
    expect(() => setSection(`x\n${MD_START}\nno end\n`, proto)).toThrow('marker');
  });
});

describe('arguments and servers', () => {
  it('parseArgs handles flags, options, = syntax and rejects unknowns', () => {
    const a = parseArgs(['x', '--yes', '--server', 'https://h', '--agent=codex-ben', 'y'], { flags: ['yes'], options: ['server', 'agent'] });
    expect([...a.flags]).toEqual(['yes']);
    expect(a.options).toEqual({ server: 'https://h', agent: 'codex-ben' });
    expect(a.positionals).toEqual(['x', 'y']);
    expect(() => parseArgs(['--token', 't'], {})).toThrow('unknown option --token');
    expect(() => parseArgs(['--server'], { options: ['server'] })).toThrow('needs a value');
    expect(() => parseArgs(['--yes=1'], { flags: ['yes'] })).toThrow('no value');
  });

  it('normalizeServer allows https anywhere and http only for this machine', () => {
    expect(normalizeServer('https://hive.example.com/')).toBe('https://hive.example.com');
    expect(normalizeServer('http://localhost:8790')).toBe('http://localhost:8790');
    expect(normalizeServer('http://127.0.0.1:8790/x/?q=1#f')).toBe('http://127.0.0.1:8790/x');
    expect(() => normalizeServer('http://hive.example.com')).toThrow('https');
    expect(() => normalizeServer('ftp://hive.example.com')).toThrow('https');
    expect(() => normalizeServer('nonsense')).toThrow('full URL');
    expect(() => normalizeServer('https://user:pw@hive.example.com')).toThrow('user name');
  });

  it('looksLikeAgentToken is a loose shape check', () => {
    expect(looksLikeAgentToken(TOKEN)).toBe(true);
    expect(looksLikeAgentToken('hm_v.test.1.VVVVVVVV')).toBe(false);
    expect(looksLikeAgentToken('hm_a.')).toBe(false);
    expect(looksLikeAgentToken(' hm_a.test.ana.1.AAAAAAAAAAAAAAAA')).toBe(false);
  });
});
