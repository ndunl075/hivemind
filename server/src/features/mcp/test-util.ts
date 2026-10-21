/** Helpers for the MCP, tasks and messages tests (Workers pool only; not imported by the Worker). */
import { SELF } from 'cloudflare:test';
import type { HookRequest, HookResponse } from '../../../../shared/contracts';
import { agentToken, hook, post } from '../../test-helpers';

export interface ToolOutcome<T = unknown> {
  /** The parsed JSON result, or the error text of an isError result. */
  value: T;
  isError: boolean;
  /** Set when the server answered with a JSON-RPC error instead of a result. */
  rpcError?: { code: number; message: string };
}

let nextId = 1;

export async function rpc(token: string, method: string, params?: unknown): Promise<Record<string, any>> {
  const res = await post('/mcp', token, { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) });
  return (await res.json()) as Record<string, any>;
}

export async function call<T = any>(token: string, name: string, args: Record<string, unknown>): Promise<ToolOutcome<T>> {
  const body = await rpc(token, 'tools/call', { name, arguments: args });
  if (body.error) return { value: body.error.message as T, isError: true, rpcError: body.error };
  const text = body.result.content[0].text as string;
  if (body.result.isError) return { value: text as T, isError: true };
  return { value: JSON.parse(text) as T, isError: false };
}

/** Sends a raw JSON string, for bodies JSON.stringify cannot make (such as 1e999). */
export function rawMcp(token: string, body: string): Promise<Response> {
  return SELF.fetch('https://example.com/mcp', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
  });
}

export interface Joined {
  token: string;
  cs: string;
  session: string;
  /** Sends a hook event as this agent. */
  hook(over?: Partial<HookRequest>): Promise<HookResponse>;
  call<T = any>(name: string, args?: Record<string, unknown>): Promise<ToolOutcome<T>>;
}

/** Starts an agent for a person in a room (SessionStart) and returns handles to act as it. */
export async function join(room: string, person: string, over: Partial<HookRequest> = {}): Promise<Joined> {
  const token = await agentToken(room, person);
  const session = `s-${person}`;
  const res = await hook(token, session, { event: 'SessionStart', ...over });
  const j: Joined = {
    token, cs: res.callsign, session,
    hook: (o = {}) => hook(token, session, { ...over, ...o }),
    call: (name, args = {}) => call(token, name, { me: res.callsign, ...args }),
  };
  return j;
}
