import { CliError } from './context.mjs';

/**
 * Tiny argument parser: positionals, `--flag`, `--name value` and `--name=value`, against a declared spec so a typo
 * is an error and not a silent no-op.
 * @param {string[]} argv
 * @param {{ flags?: string[], options?: string[] }} [spec]
 * @returns {{ positionals: string[], flags: Set<string>, options: Record<string, string> }}
 */
export function parseArgs(argv, spec = {}) {
  const flags = new Set();
  /** @type {Record<string, string>} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positionals.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if ((spec.flags ?? []).includes(name)) {
      if (eq !== -1) throw new CliError(`--${name} takes no value`);
      flags.add(name);
    } else if ((spec.options ?? []).includes(name)) {
      const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined || value === '') throw new CliError(`--${name} needs a value`);
      options[name] = value;
    } else {
      throw new CliError(`unknown option --${name}`);
    }
  }
  return { positionals, flags, options };
}

/**
 * @param {string[]} positionals
 * @param {number} count
 * @param {string} usage
 */
export function needPositionals(positionals, count, usage) {
  if (positionals.length !== count) throw new CliError(`usage: hivemind ${usage}`);
  return positionals;
}
