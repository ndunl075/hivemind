/**
 * Admin commands (ARCHITECTURE.md §17): room create/delete, invite, revoke, rotate, webhook.
 * The admin secret comes from HIVEMIND_ADMIN_TOKEN, a hidden prompt in a terminal, or one piped line with
 * --token-stdin; never from argv. A token or dashboard link is
 * printed exactly once, by the command that issues it, on its own line so it is easy to copy.
 * @typedef {import('./context.mjs').Context} Context
 */
import { parseArgs, needPositionals } from './args.mjs';
import { call, dashboardLink, normalizeServer } from './api.mjs';
import { CliError } from './context.mjs';
import { readConfig } from './install.mjs';

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PERSON_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** @param {string} room */
function checkRoom(room) {
  if (!ROOM_NAME_RE.test(room)) throw new CliError('room names are lowercase letters, digits and hyphens, up to 40 characters');
  if (room === 'test') throw new CliError('the room name "test" is reserved');
  return room;
}

/** @param {string} person */
function checkPerson(person) {
  if (!PERSON_NAME_RE.test(person)) throw new CliError('person names are lowercase letters, digits, - and _, up to 32 characters');
  return person;
}

/**
 * The server to talk to: --server, HIVEMIND_SERVER, this laptop's config, or a question.
 * @param {Context} ctx
 * @param {Record<string, string>} options
 */
export async function resolveServer(ctx, options) {
  const given = options.server ?? ctx.env.HIVEMIND_SERVER ?? readConfig(ctx)?.server;
  return normalizeServer(given ?? (await ctx.readLine('Server URL')));
}

/**
 * @param {Context} ctx
 * @param {Record<string, string>} options
 * @param {Set<string>} flags
 */
async function adminSession(ctx, options, flags) {
  const server = await resolveServer(ctx, options);
  const secret = ctx.env.HIVEMIND_ADMIN_TOKEN || (flags.has('token-stdin') ? await ctx.readStdin() : await ctx.readSecret('Admin secret (input hidden)'));
  if (!secret) throw new CliError('an admin secret is needed (HIVEMIND_ADMIN_TOKEN, --token-stdin, or type it when asked)');
  return { server, secret };
}

const SPEC = { flags: ['token-stdin'], options: ['server'] };

/**
 * hivemind room create <room> | hivemind room delete <room> [--yes]
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function room(argv, ctx) {
  const { positionals, flags, options } = parseArgs(argv, { flags: ['yes', 'token-stdin'], options: ['server'] });
  const [sub, name] = positionals;
  if (positionals.length !== 2 || (sub !== 'create' && sub !== 'delete')) throw new CliError('usage: hivemind room create|delete <room>');
  checkRoom(/** @type {string} */ (name));
  if (sub === 'create') {
    const { server, secret } = await adminSession(ctx, options, flags);
    const res = await call(ctx, server, '/admin/rooms', { token: secret, body: { room: name } });
    if (typeof res.viewerToken !== 'string') throw new CliError('the server answered without a dashboard token');
    ctx.out(`Room "${name}" created.\n`);
    ctx.out('Dashboard link (read-only; shown only now, copy it):\n');
    ctx.out(`${dashboardLink(server, /** @type {string} */ (name), res.viewerToken)}\n`);
    ctx.out(`Next: hivemind invite ${name} <person>\n`);
    return 0;
  }
  if (!flags.has('yes')) {
    if (!ctx.interactive) throw new CliError('deleting a room needs --yes when there is no terminal');
    const typed = await ctx.readLine(`This deletes all data of room "${name}". Type the room name to confirm`);
    if (typed !== name) throw new CliError('cancelled: the name did not match');
  }
  const { server, secret } = await adminSession(ctx, options, flags);
  await call(ctx, server, `/admin/rooms/${name}`, { method: 'DELETE', token: secret });
  ctx.out(`Room "${name}" deleted.\n`);
  return 0;
}

/**
 * hivemind invite <room> <person>
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function invite(argv, ctx) {
  const { positionals, flags, options } = parseArgs(argv, SPEC);
  const [name, person] = needPositionals(positionals, 2, 'invite <room> <person>');
  checkRoom(/** @type {string} */ (name));
  checkPerson(/** @type {string} */ (person));
  const { server, secret } = await adminSession(ctx, options, flags);
  const res = await call(ctx, server, `/admin/rooms/${name}/invite`, { token: secret, body: { person } });
  if (typeof res.agentToken !== 'string') throw new CliError('the server answered without a token');
  ctx.out(`Agent token for ${person} in room "${name}" (shown only now; send it to ${person} privately):\n`);
  ctx.out(`${res.agentToken}\n`);
  ctx.out(`${person} then runs: hivemind join\n`);
  return 0;
}

/**
 * hivemind revoke <room> <person>
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function revoke(argv, ctx) {
  const { positionals, flags, options } = parseArgs(argv, SPEC);
  const [name, person] = needPositionals(positionals, 2, 'revoke <room> <person>');
  checkRoom(/** @type {string} */ (name));
  checkPerson(/** @type {string} */ (person));
  const { server, secret } = await adminSession(ctx, options, flags);
  await call(ctx, server, `/admin/rooms/${name}/revoke`, { token: secret, body: { person } });
  ctx.out(`${person}'s token for room "${name}" is revoked. Their agents are signed out.\n`);
  return 0;
}

/**
 * hivemind rotate <room> --agents | --viewer
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function rotate(argv, ctx) {
  const { positionals, flags, options } = parseArgs(argv, { flags: ['agents', 'viewer', 'token-stdin'], options: ['server'] });
  const [name] = needPositionals(positionals, 1, 'rotate <room> --agents|--viewer');
  if (flags.has('agents') === flags.has('viewer')) throw new CliError('give exactly one of --agents or --viewer');
  checkRoom(/** @type {string} */ (name));
  const { server, secret } = await adminSession(ctx, options, flags);
  if (flags.has('agents')) {
    await call(ctx, server, `/admin/rooms/${name}/revoke`, { token: secret, body: { rotate: 'agents' } });
    ctx.out(`All agent tokens for room "${name}" are invalid now.\n`);
    ctx.out(`Invite everyone again (hivemind invite ${name} <person>); each person runs hivemind join again.\n`);
    return 0;
  }
  const res = await call(ctx, server, `/admin/rooms/${name}/revoke`, { token: secret, body: { rotate: 'viewer' } });
  if (typeof res.viewerToken !== 'string') throw new CliError('the server answered without a dashboard token');
  ctx.out('The old dashboard link no longer works. New link (read-only; shown only now, copy it):\n');
  ctx.out(`${dashboardLink(server, /** @type {string} */ (name), res.viewerToken)}\n`);
  return 0;
}

/**
 * hivemind webhook <room> [--off]
 * Creates the room's GitHub push webhook, or rotates it (the old URL and secret stop working), and prints the Payload
 * URL and secret once. `--off` switches it off. A webhook only produces push notices (ARCHITECTURE.md §12).
 * @param {string[]} argv
 * @param {Context} ctx
 */
export async function webhook(argv, ctx) {
  const { positionals, flags, options } = parseArgs(argv, { flags: ['off', 'token-stdin'], options: ['server'] });
  const [name] = needPositionals(positionals, 1, 'webhook <room> [--off]');
  checkRoom(/** @type {string} */ (name));
  const { server, secret } = await adminSession(ctx, options, flags);
  if (flags.has('off')) {
    await call(ctx, server, `/admin/rooms/${name}/webhook`, { token: secret, body: { disable: true } });
    ctx.out(`The GitHub webhook of room "${name}" is off. Deliveries to its old URL are refused; you can delete it in the repository's settings.\n`);
    return 0;
  }
  const res = await call(ctx, server, `/admin/rooms/${name}/webhook`, { token: secret, body: {} });
  if (typeof res.path !== 'string' || typeof res.secret !== 'string') throw new CliError('the server answered without a webhook URL and secret');
  ctx.out(`GitHub webhook for room "${name}". In the repository on github.com: Settings > Webhooks > Add webhook (or edit the existing one):\n`);
  ctx.out('  Payload URL (copy it):\n');
  ctx.out(`${server}${res.path}\n`);
  ctx.out('  Secret (shown only now, copy it):\n');
  ctx.out(`${res.secret}\n`);
  ctx.out('  Content type: application/json\n');
  ctx.out('  SSL verification: enabled\n');
  ctx.out('  Events: "Let me select individual events", then tick only "Pushes"\n');
  ctx.out('  Active: ticked\n');
  ctx.out('Agents whose repo\'s origin URL ends in the repository name get a "pulled before editing" notice for pushes and merges made outside any agent.\n');
  ctx.out(`Running this command again rotates the URL and secret; update GitHub when you do. Switch it off with: hivemind webhook ${name} --off\n`);
  return 0;
}
