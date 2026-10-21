/**
 * Terminal input for the CLI. Secrets are read in raw mode with nothing echoed; they are never taken from argv.
 */
import { createInterface } from 'node:readline';
import { CliError } from './context.mjs';

/**
 * One shared line reader for piped input, so a second prompt doesn't lose lines the first one buffered.
 * @type {AsyncIterator<string> | null}
 */
let pipedLines = null;

/**
 * @param {NodeJS.ReadStream} stdin
 * @returns {Promise<string | null>}
 */
function nextPipedLine(stdin) {
  if (!pipedLines) pipedLines = createInterface({ input: stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  return pipedLines.next().then((r) => (r.done ? null : r.value));
}

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

  /** @param {string} label */
  async function readSecret(label) {
    stderr.write(`${label}: `);
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
      const line = await nextPipedLine(stdin);
      stderr.write('\n');
      if (line === null) throw new CliError('input ended before an answer was given');
      return line.trim();
    }
    return new Promise((resolve, reject) => {
      let value = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      /** @param {() => void} fn */
      const done = (fn) => {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        stderr.write('\n');
        fn();
      };
      /** @param {string} chunk */
      function onData(chunk) {
        for (const ch of chunk.replace(/\x1b\[[0-9;]*[~A-Za-z]/g, '')) {
          if (ch === '\r' || ch === '\n') return done(() => resolve(value.trim()));
          if (ch === '\x03') return done(() => reject(new CliError('cancelled', 130)));
          if (ch === '\x7f' || ch === '\b') value = value.slice(0, -1);
          else if (ch >= ' ') value += ch;
        }
      }
      stdin.on('data', onData);
    });
  }

  return { readLine, readSecret };
}
