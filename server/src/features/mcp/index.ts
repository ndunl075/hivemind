/**
 * MCP endpoint (ARCHITECTURE.md §7): stateless Streamable HTTP, JSON responses. Wave 1 serves `initialize`,
 * `tools/list`, `tools/call` and `ping`, with the `status` tool. W4 (tasks-and-messages) adds the other tools by
 * adding entries to TOOLS.
 *
 * All responses go through writeMcpResponse(): one small function, so switching to a single-event SSE stream
 * (the §21 fallback) is a change in one place.
 */
import type { AgentRecord, Callsign, ToolName, ToolResults } from '../../../../shared/contracts';
import { deriveState } from '../../../../shared/state';
import protocol from '../../../../shared/protocol.md';
import { type RoomServices } from '../../services';
import { errorResponse, json } from '../../util';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'hivemind', version: '0.1.0' };

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

/** An error the tool wants shown to the agent (isError result), not a protocol error. */
export class ToolError extends Error {}

export interface ToolContext {
  svc: RoomServices;
  person: string;
  /** The caller, for every tool except `register`. */
  agent: AgentRecord;
}

export interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  /** Tools that don't take `me` (register). */
  noMe?: boolean;
  run(tc: ToolContext, args: Record<string, unknown>): Promise<unknown> | unknown;
}

const meSchema = { type: 'string', description: 'Your callsign, from your Hivemind briefing.' };

function statusTool(tc: ToolContext): ToolResults['status'] {
  const { ctx, features } = tc.svc;
  const me = tc.agent;
  const now = ctx.now();
  const tasks = features.tasks;
  const view = (a: AgentRecord) => tc.svc.agents.view(a, tasks.inProgressFor(a.callsign)?.id ?? null);
  const roster = ctx.agents()
    .map((a) => ({ a, d: deriveState(a, now) }))
    .filter((x) => x.d.state !== 'ended')
    .map((x) => ({ ...view(x.a), state: x.d.state, takeable: x.d.takeable }));
  const locks = features.locks.list();
  const counter = features.messages as { unreadCount?: (cs: Callsign) => number };
  return {
    you: view(me),
    mode: ctx.mode(),
    agents: roster,
    tasks: tasks.list().filter((t) => t.status === 'open' || t.status === 'in_progress'),
    heldByOthers: locks.filter((l) => l.holder !== me.callsign),
    yours: locks.filter((l) => l.holder === me.callsign),
    unread: counter.unreadCount ? counter.unreadCount(me.callsign) : features.messages.hasUnreadDirect(me.callsign) ? 1 : 0,
  };
}

export const TOOLS: Partial<Record<ToolName, ToolDef>> = {
  status: {
    description: 'See the room: other agents and their states, open and in-progress tasks, locks held by others, your own holdings and unread messages. Call it before choosing work.',
    inputSchema: { type: 'object', properties: { me: meSchema }, required: ['me'] },
    run: (tc) => statusTool(tc),
  },
};

/** The one place that writes an MCP response. */
export function writeMcpResponse(payload: unknown | null): Response {
  if (payload === null) return new Response(null, { status: 202 });
  return json(payload);
}

function rpcError(id: JsonRpcId, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function textResult(value: unknown, isError = false): unknown {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

async function dispatch(svc: RoomServices, person: string, msg: JsonRpcRequest): Promise<unknown | null> {
  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;
  if (isNotification) return null; // notifications/initialized and friends need no answer
  switch (msg.method) {
    case 'initialize': {
      const asked = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '';
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: protocol,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0', id,
        result: {
          tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t?.description, inputSchema: t?.inputSchema })),
        },
      };
    case 'tools/call': {
      const name = msg.params?.name;
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = typeof name === 'string' ? TOOLS[name as ToolName] : undefined;
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      let agent: AgentRecord | null = null;
      if (!tool.noMe) {
        const me = args.me;
        if (typeof me !== 'string' || me === '') return { jsonrpc: '2.0', id, result: textResult('`me` is required: pass your callsign.', true) };
        agent = svc.agents.get(me);
        if (!agent || agent.person !== person) {
          return { jsonrpc: '2.0', id, result: textResult(`"${me}" is not your callsign. Use the one in your Hivemind briefing.`, true) };
        }
        svc.agents.touch(agent);
      }
      try {
        const out = await tool.run({ svc, person, agent: agent as AgentRecord }, args);
        return { jsonrpc: '2.0', id, result: textResult(out) };
      } catch (e) {
        if (e instanceof ToolError) return { jsonrpc: '2.0', id, result: textResult(e.message, true) };
        throw e;
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

function isRequest(v: unknown): v is JsonRpcRequest {
  return typeof v === 'object' && v !== null && (v as JsonRpcRequest).jsonrpc === '2.0' && typeof (v as JsonRpcRequest).method === 'string';
}

export async function handleMcp(svc: RoomServices, person: string, request: Request): Promise<Response> {
  if (request.method !== 'POST') return errorResponse('method not allowed', 405, { allow: 'POST' });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(rpcError(null, -32700, 'Parse error'), 400);
  }
  if (Array.isArray(body)) {
    const out: unknown[] = [];
    for (const m of body) {
      const r = isRequest(m) ? await dispatch(svc, person, m) : (m && typeof m === 'object' && 'result' in m ? null : rpcError(null, -32600, 'Invalid Request'));
      if (r !== null) out.push(r);
    }
    return writeMcpResponse(out.length > 0 ? out : null);
  }
  if (!isRequest(body)) return json(rpcError(null, -32600, 'Invalid Request'), 400);
  return writeMcpResponse(await dispatch(svc, person, body));
}

