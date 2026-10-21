/**
 * Messaging (ARCHITECTURE.md §11). Agent posts and notices from 'hivemind', delivered once per recipient through the
 * hook points (deny reason, heartbeat, prompt, Stop, SessionStart), `inbox` and `wait`. Held in memory (500 messages at
 * most) with SQLite behind it, so a heartbeat never reads rows.
 *
 * - Direct messages and notices go to one callsign; broadcasts ('*') go to every other agent that was already
 *   running when they were sent (and, for notices, the repo and exclude filters).
 * - Only direct messages can block Stop; that rule is applied by the pipeline through hasUnreadDirect().
 * - A message to an agent that has ended bounces back to the sender as a notice, and so do unread direct messages
 *   of an agent that ends before reading them (forget()).
 * - Everything is framed by format(): attributed, quoted, never an instruction.
 */
import {
  LIMITS, type Callsign, type FeatureFactory, type MessageView, type Millis, type MessagesApi, type NotifyOptions,
} from '../../../../shared/contracts';
import { deriveState } from '../../../../shared/state';
import { agoText } from '../../util';
import { cleanBlock } from './sanitize';

/** What the messages feature offers beyond MessagesApi, to the MCP tools. */
export interface MessagesOps {
  /** Stores a message from an agent and wakes its recipients, or bounces it. Text is cleaned and capped here. */
  send(from: Callsign, to: Callsign | '*', text: string): { id: number } | { bounced: true; reason: string };
  /** The last `limit` messages addressed to a callsign (direct, broadcast and notices), delivered or not. */
  recent(callsign: Callsign, limit: number): MessageView[];
}

export type FullMessages = MessagesApi & MessagesOps;

interface Msg extends MessageView {
  /** For '*' notices with options: callsigns that must never receive it. */
  skip: Set<Callsign>;
  repo: string | null;
}

function parseList(v: unknown): string[] {
  try {
    const x: unknown = typeof v === 'string' ? JSON.parse(v) : [];
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

const snippet = (text: string, n: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export const createMessages: FeatureFactory<'messages'> = (ctx) => {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
    exclude TEXT, repo TEXT)`).toArray(); // exclude (JSON list) and repo hold the notify() filters of a '*' notice
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    message_id INTEGER NOT NULL, callsign TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY (message_id, callsign))`).toArray();

  const messages: Msg[] = [];
  const delivered = new Map<Callsign, Set<number>>();
  let nextId = 1;

  for (const r of ctx.sql.exec('SELECT * FROM messages ORDER BY id').toArray()) {
    messages.push({
      id: Number(r.id), sender: String(r.sender), recipient: String(r.recipient), text: String(r.text),
      createdAt: Number(r.created_at), skip: new Set(parseList(r.exclude)), repo: r.repo === null ? null : String(r.repo),
    });
    nextId = Math.max(nextId, Number(r.id) + 1);
  }
  for (const r of ctx.sql.exec('SELECT message_id, callsign FROM deliveries').toArray()) {
    const cs = String(r.callsign);
    const set = delivered.get(cs) ?? new Set<number>();
    set.add(Number(r.message_id));
    delivered.set(cs, set);
  }

  const isActive = (cs: Callsign): boolean => {
    const a = ctx.agent(cs);
    return !!a && deriveState(a, ctx.now()).state !== 'ended';
  };

  const deliverable = (m: Msg, callsign: Callsign, startedAt: Millis, repo: string | null): boolean => {
    if (m.recipient === callsign) return true;
    if (m.recipient !== '*' || m.sender === callsign || m.skip.has(callsign)) return false;
    if (m.repo !== null && m.repo !== repo) return false;
    return m.createdAt >= startedAt;
  };

  const unreadFor = (callsign: Callsign, directOnly: boolean): Msg[] => {
    const a = ctx.agent(callsign);
    if (!a) return [];
    const seen = delivered.get(callsign);
    const out: Msg[] = [];
    for (const m of messages) {
      if (seen?.has(m.id)) continue;
      if (directOnly && m.recipient !== callsign) continue;
      if (deliverable(m, callsign, a.startedAt, a.repo)) out.push(m);
    }
    return out;
  };

  const trim = (): void => {
    if (messages.length <= LIMITS.keepMessages) return;
    const drop = messages.splice(0, messages.length - LIMITS.keepMessages);
    const lastDropped = drop[drop.length - 1]?.id ?? 0;
    ctx.sql.exec('DELETE FROM messages WHERE id <= ?', lastDropped).toArray();
    ctx.sql.exec('DELETE FROM deliveries WHERE message_id <= ?', lastDropped).toArray();
    for (const set of delivered.values()) for (const m of drop) set.delete(m.id);
  };

  const view = ({ id, sender, recipient, text, createdAt }: Msg): MessageView => ({ id, sender, recipient, text, createdAt });

  const quote = (text: string): string => text.split('\n').map((l) => `> ${l}`).join('\n');

  const store = (sender: Callsign | 'hivemind', to: Callsign | '*', text: string, repo: string | null, skip: string[]): Msg => {
    const msg: Msg = { id: nextId++, sender, recipient: to, text, createdAt: ctx.now(), skip: new Set(skip), repo };
    messages.push(msg);
    ctx.sql.exec('INSERT INTO messages (id, sender, recipient, text, created_at, exclude, repo) VALUES (?,?,?,?,?,?,?)',
      msg.id, msg.sender, msg.recipient, msg.text, msg.createdAt,
      msg.skip.size > 0 ? JSON.stringify([...msg.skip]) : null, msg.repo).toArray();
    trim();
    return msg;
  };

  /** Callsigns of the active agents that will receive a '*' message. */
  const broadcastTargets = (msg: Msg): Callsign[] =>
    ctx.agents().filter((a) => isActive(a.callsign) && deliverable(msg, a.callsign, 0, a.repo)).map((a) => a.callsign);

  const notify = (to: Callsign | '*', text: string, options: NotifyOptions = {}): void => {
    const clean = cleanBlock(text, LIMITS.maxMessageChars);
    const msg = store('hivemind', to, clean, to === '*' ? (options.repo ?? null) : null, options.exclude ?? []);
    const targets = to === '*' ? broadcastTargets(msg) : [to];
    ctx.emit({
      type: 'message.notice', actor: null, text: `notice: ${snippet(clean, 120)}`,
      data: { to, id: msg.id }, wake: targets.map((cs) => `message:${cs}`),
    });
  };

  const api: FullMessages = {
    notify,

    send(from, to, rawText) {
      const text = cleanBlock(rawText, LIMITS.maxMessageChars);
      if (to === from) return { bounced: true, reason: 'That is your own callsign. Messages go to other agents.' };
      if (to !== '*') {
        const target = ctx.agent(to);
        let reason: string | null = null;
        if (!target) reason = `There is no agent called ${to} in this room.`;
        else if (!isActive(to)) reason = `${to} has ended, so it cannot read messages.`;
        if (reason !== null) {
          notify(from, `Your message to ${to} bounced: ${reason}\nYour message: ${snippet(text, 200)}`);
          return { bounced: true, reason };
        }
      }
      const msg = store(from, to, text, null, []);
      const targets = to === '*' ? broadcastTargets(msg) : [to];
      ctx.emit({
        type: to === '*' ? 'message.broadcast' : 'message.sent', actor: from,
        text: to === '*' ? `${from} to everyone: ${snippet(text, 120)}` : `${from} to ${to}: ${snippet(text, 120)}`,
        data: { to, id: msg.id },
        pulse: to === '*' ? { kind: 'broadcast', from } : { kind: 'message', from, to },
        edge: to === '*' ? { kind: 'broadcast', from } : { kind: 'message', from, to },
        wake: targets.map((cs) => `message:${cs}`),
      });
      return { id: msg.id };
    },

    takeUnread(callsign: Callsign, options?: { directOnly?: boolean }): MessageView[] {
      const unread = unreadFor(callsign, options?.directOnly === true);
      if (unread.length === 0) return [];
      const set = delivered.get(callsign) ?? new Set<number>();
      delivered.set(callsign, set);
      const now = ctx.now();
      for (const m of unread) {
        set.add(m.id);
        ctx.sql.exec('INSERT OR IGNORE INTO deliveries (message_id, callsign, delivered_at) VALUES (?,?,?)', m.id, callsign, now).toArray();
      }
      return unread.map(view);
    },

    hasUnreadDirect(callsign: Callsign): boolean {
      return unreadFor(callsign, true).length > 0;
    },

    recent(callsign, limit) {
      const a = ctx.agent(callsign);
      if (!a) return [];
      const out: MessageView[] = [];
      for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
        const m = messages[i] as Msg;
        if (deliverable(m, callsign, a.startedAt, a.repo)) out.push(view(m));
      }
      return out.reverse();
    },

    format(list: MessageView[], now: Millis): string {
      return list.map((m) => (m.sender === 'hivemind'
        ? `[Hivemind] notice (${agoText(now, m.createdAt)}):\n${quote(m.text)}`
        : `[Hivemind] message from ${m.sender} (${agoText(now, m.createdAt)}), a teammate's agent:\n${quote(m.text)}`)).join('\n\n');
    },

    /**
     * Drops everything held for a callsign that is being reused or deleted: its direct messages and delivered state.
     * Direct messages from agents that it never read bounce back to their senders.
     */
    forget(callsign: Callsign): void {
      const seen = delivered.get(callsign);
      delivered.delete(callsign);
      const gone = messages.filter((m) => m.recipient === callsign);
      if (gone.length === 0) return;
      for (const m of gone) messages.splice(messages.indexOf(m), 1);
      ctx.sql.exec('DELETE FROM deliveries WHERE callsign = ? OR message_id IN (SELECT id FROM messages WHERE recipient = ?)', callsign, callsign).toArray();
      ctx.sql.exec('DELETE FROM messages WHERE recipient = ?', callsign).toArray();
      const lost = new Map<Callsign, Msg[]>();
      for (const m of gone) {
        if (m.sender === 'hivemind' || seen?.has(m.id) || m.sender === callsign) continue;
        lost.set(m.sender, [...(lost.get(m.sender) ?? []), m]);
      }
      for (const [sender, list] of lost) {
        if (!isActive(sender)) continue;
        const first = list[0] as Msg;
        const more = list.length > 1 ? ` (and ${list.length - 1} more)` : '';
        notify(sender, `Your message to ${callsign} was never read: ${callsign} ended first.${more}\nYour message: ${snippet(first.text, 200)}`);
      }
    },

    unreadCount(callsign: Callsign): number {
      return unreadFor(callsign, false).length;
    },
  };
  return api;
};
