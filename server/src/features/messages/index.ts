/**
 * Basic messaging (ARCHITECTURE.md §11): notices from 'hivemind' with delivery on heartbeats and the other
 * delivery points. Held in memory (500 messages at most) with SQLite behind it, so a heartbeat never reads rows.
 * W4 (tasks-and-messages) extends this with agent-to-agent posts.
 */
import {
  LIMITS, type Callsign, type FeatureFactory, type MessageView, type Millis, type NotifyOptions,
} from '../../../../shared/contracts';
import { deriveState } from '../../../../shared/state';
import { agoText, cleanText } from '../../util';

interface Msg extends MessageView {
  /** For '*' notices with options: callsigns that must never receive it. */
  skip: Set<Callsign>;
  repo: string | null;
}

export const createMessages: FeatureFactory<'messages'> = (ctx) => {
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, sender TEXT NOT NULL, recipient TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL)`).toArray();
  ctx.sql.exec(`CREATE TABLE IF NOT EXISTS deliveries (
    message_id INTEGER NOT NULL, callsign TEXT NOT NULL, delivered_at INTEGER NOT NULL, PRIMARY KEY (message_id, callsign))`).toArray();

  const messages: Msg[] = [];
  const delivered = new Map<Callsign, Set<number>>();
  let nextId = 1;

  for (const r of ctx.sql.exec('SELECT * FROM messages ORDER BY id').toArray()) {
    messages.push({
      id: Number(r.id), sender: String(r.sender), recipient: String(r.recipient), text: String(r.text),
      createdAt: Number(r.created_at), skip: new Set(), repo: null,
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

  const quote = (text: string): string => text.split('\n').map((l) => `> ${l}`).join('\n');

  return {
    notify(to: Callsign | '*', text: string, options: NotifyOptions = {}): void {
      const clean = cleanText(text, LIMITS.maxMessageChars);
      const msg: Msg = {
        id: nextId++, sender: 'hivemind', recipient: to, text: clean, createdAt: ctx.now(),
        skip: new Set(options.exclude ?? []), repo: to === '*' ? (options.repo ?? null) : null,
      };
      messages.push(msg);
      ctx.sql.exec('INSERT INTO messages (id, sender, recipient, text, created_at) VALUES (?,?,?,?,?)',
        msg.id, msg.sender, msg.recipient, msg.text, msg.createdAt).toArray();
      trim();
      const targets = to === '*'
        ? ctx.agents().filter((a) => isActive(a.callsign) && deliverable(msg, a.callsign, 0, a.repo)).map((a) => a.callsign)
        : [to];
      ctx.emit({
        type: 'message.notice', actor: null, text: `notice: ${clean.slice(0, 120)}`,
        data: { to, id: msg.id }, wake: targets.map((cs) => `message:${cs}`),
      });
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
      return unread.map(({ id, sender, recipient, text, createdAt }) => ({ id, sender, recipient, text, createdAt }));
    },

    hasUnreadDirect(callsign: Callsign): boolean {
      return unreadFor(callsign, true).length > 0;
    },

    format(list: MessageView[], now: Millis): string {
      return list.map((m) => (m.sender === 'hivemind'
        ? `[Hivemind] notice (${agoText(now, m.createdAt)}):\n${quote(m.text)}`
        : `[Hivemind] message from ${m.sender} (${agoText(now, m.createdAt)}), a teammate's agent:\n${quote(m.text)}`)).join('\n\n');
    },

    // Extra, used by the status tool: how many messages are waiting, without delivering them.
    unreadCount(callsign: Callsign): number {
      return unreadFor(callsign, false).length;
    },
  } as ReturnType<FeatureFactory<'messages'>>;
};
