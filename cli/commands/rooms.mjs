/**
 * The rooms in config.json (ARCHITECTURE.md §6.1). One laptop can be in several rooms, each tied to the repos it was
 * joined from.
 *
 * File format. The file keeps the original single-room fields at the top level and adds a `rooms` list:
 *
 *   { "server", "room", "person", "token", "repos",            <- a copy of the primary room (for older hooks/helpers)
 *     "rooms": [ { "server", "room", "person", "token", "repos", "mcp" }, ... ] }
 *
 * A file without `rooms` is the old single-room format and reads as one room. The top-level copy is why an older
 * installed hook or headers helper keeps working against a file written by a newer CLI (it sees the primary room
 * only), and why a newer hook reads an old file with no migration step. The file is rewritten in the new shape the
 * next time `join` or `update` writes it.
 *
 * `mcp` is the name of the MCP server registered for the room: `hivemind` for the first room (so a single-room
 * laptop looks exactly as before), `hivemind-<room>` for later ones. It never changes once assigned.
 */
import { CliError } from './context.mjs';

/** @typedef {{ server: string, room: string, person: string, token: string, repos: string[], mcp: string }} RoomEntry */

export const DEFAULT_MCP = 'hivemind';
/** The names `mcp` may take: `hivemind`, or `hivemind-` and lowercase words joined by dashes. */
export const MCP_NAME = /^hivemind(?:-[a-z0-9]+)*$/;

/**
 * A room name as part of an MCP server name: lowercase letters and digits joined by single dashes.
 * @param {string} room
 */
export function slug(room) {
  const s = room.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/, '');
  return s === '' ? 'room' : s;
}

/**
 * The names a new room's MCP server may take, best first: `hivemind`, `hivemind-<room>`, then `-2`, `-3`...
 * @param {string} room
 * @param {number} [count]
 */
export function candidateNames(room, count = 12) {
  const base = `${DEFAULT_MCP}-${slug(room)}`;
  return [DEFAULT_MCP, base, ...Array.from({ length: count }, (_, i) => `${base}-${i + 2}`)];
}

/**
 * The MCP server name for a new room: the first candidate that no room uses and that is not in `taken`. `taken` holds
 * names that might still be registered, by Hivemind for a room that was left or by the user: a name is never reused
 * while a registration under it could still exist.
 * @param {Array<{ mcp: string }>} rooms
 * @param {string} room
 * @param {Set<string>} [taken]
 */
export function allocateMcp(rooms, room, taken = new Set()) {
  const used = new Set([...rooms.map((r) => r.mcp), ...taken]);
  for (const n of candidateNames(room, 1000)) if (!used.has(n)) return n;
  throw new CliError('no free MCP server name for this room');
}

/**
 * Rooms out of the parsed config.json, old or new format. Null when nothing usable is in it.
 * @param {unknown} c parsed JSON
 * @returns {RoomEntry[] | null}
 */
export function roomsFromJson(c) {
  if (typeof c !== 'object' || c === null) return null;
  const o = /** @type {Record<string, any>} */ (c);
  /** @type {unknown[]} */
  const raw = Array.isArray(o.rooms) ? o.rooms : [o];
  /** @type {RoomEntry[]} */
  const rooms = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const e = /** @type {Record<string, any>} */ (r);
    if (typeof e.server !== 'string' || typeof e.token !== 'string' || !Array.isArray(e.repos)) continue;
    const mcp = typeof e.mcp === 'string' && MCP_NAME.test(e.mcp) && !rooms.some((x) => x.mcp === e.mcp) ? e.mcp : '';
    rooms.push({
      server: e.server,
      room: String(e.room ?? ''),
      person: String(e.person ?? ''),
      token: e.token,
      repos: e.repos.filter((/** @type {unknown} */ x) => typeof x === 'string'),
      mcp,
    });
  }
  if (rooms.length === 0) return null;
  // Entries without a (valid) name get one now; the first room of an old file is `hivemind`.
  for (const r of rooms) if (r.mcp === '') r.mcp = allocateMcp(rooms, r.room);
  return rooms;
}

/**
 * The file's contents for these rooms: the primary room's fields at the top level, then the full list.
 * The primary room is the one served by the plain `hivemind` MCP server, else the first.
 * @param {RoomEntry[]} rooms
 */
export function configJson(rooms) {
  const primary = rooms.find((r) => r.mcp === DEFAULT_MCP) ?? rooms[0];
  if (!primary) throw new CliError('no room to write');
  const entry = (/** @type {RoomEntry} */ r) => ({ server: r.server, room: r.room, person: r.person, token: r.token, repos: r.repos, mcp: r.mcp });
  return {
    server: primary.server, room: primary.room, person: primary.person, token: primary.token, repos: primary.repos,
    rooms: rooms.map(entry),
  };
}

/**
 * The room a repository belongs to, or undefined. The first room that lists it wins.
 * @param {RoomEntry[]} rooms
 * @param {string} repo root commit
 */
export function roomForRepo(rooms, repo) {
  return rooms.find((r) => r.repos.includes(repo));
}

/** @param {string} server @param {string} room */
export const sameRoom = (server, room) => (/** @type {RoomEntry} */ r) => r.server.replace(/\/+$/, '') === server.replace(/\/+$/, '') && r.room === room;
