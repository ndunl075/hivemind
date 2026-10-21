/**
 * Terminal input for the CLI. Secrets are read in raw mode with nothing echoed; they are never taken from argv.
 * Without a terminal a secret is refused, unless the caller asked for piped input explicitly (--token-stdin).
 */
import { createInterface } from 'node:readline';
import { CliError } from './context.mjs';

/**
 * One shared line reader per input stream, so a second prompt doesn't lose lines the first one buffered.
 * @type {WeakMap<object, AsyncIterator<string>>}
 */
const pipedLines = new WeakMap();

/**
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string | null>}
 */
function nextPipedLine(stdin) {
  let it = pipedLines.get(stdin);
  if (!it) {
    it = createInterface({ input: stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
    pipedLines.set(stdin, it);
  }
  return it.next().then((r) => (r.done ? null : r.value));
}

/** Shown when a secret is needed and there is nobody at a keyboard. */
export const NO_TERMINAL_MESSAGE =
  'cannot ask for a secret here because input is not a terminal. Run this in a real terminal, or pipe the value in on purpose with --token-stdin.';

/**
 * Prompt text goes to stderr so stdout stays clean for the one thing a command prints.
 * @param {{ stdin?: NodeJS.ReadStream, stderr?: NodeJS.WriteStream }} [io]
 */
export function terminalReaders(io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stderr = io.stderr ?? process.stderr;

  /** @param {string} label */
  async function readLine(label) {
    stderr.write(`${label}: `);
    if (!stdin.isTTY) {
      const line = await nextPipedLine(stdin);
      stderr.write('\n');
      if (line === null) throw new CliError('input ended before an answer was given');
      return line.trim();
    }
    const rl = createInterface({ input: stdin, output: stderr, terminal: true });
    try {
      return await new Promise((resolve, reject) => {
        rl.once('line', (l) => resolve(l.trim()));
        rl.once('close', () => reject(new CliError('input ended before an answer was given')));
      });
    } finally {
      rl.close();
    }
  }

  /**
   * One line of piped input, for --token-stdin. Refused when stdin is a terminal (the hidden prompt is better there).
   */
  async function readStdin() {
    if (stdin.isTTY) throw new CliError('--token-stdin is for piped input; leave it out to be asked in this terminal');
    const line = await nextPipedLine(stdin);
    if (line === null || line.trim() === '') throw new CliError('no value arrived on standard input');
    return line.trim();
  }

  /** @param {string} label */
  async function readSecret(label) {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new CliError(NO_TERMINAL_MESSAGE);
    stderr.write(`${label}: `);
    return new Promise((resolve, reject) => {
      let value = '';
      let finished = false;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      /** @param {() => void} fn */
      const done = (fn) => {
        if (finished) return;
        finished = true;
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        stdin.removeListener('close', onEnd);
        stdin.removeListener('error', onEnd);
        try { stdin.setRawMode(false); } catch { /* stream already gone */ }
        stdin.pause();
        stderr.write('\n');
        fn();
      };
      const onEnd = () => done(() => reject(new CliError('input ended before an answer was given')));
      /** @param {string} chunk */
      function onData(chunk) {
        for (const ch of chunk.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '')) {
          if (ch === '\r' || ch === '\n') return done(() => resolve(value.trim()));
          if (ch === '\x03') return done(() => reject(new CliError('cancelled', 130)));
          if (ch === '\x04' && value === '') return onEnd();
          if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
          else if (ch >= ' ') value += ch;
        }
      }
      stdin.on('data', onData);
      stdin.once('end', onEnd);
      stdin.once('close', onEnd);
      stdin.once('error', onEnd);
    });
  }

  return { readLine, readSecret, readStdin };
}
