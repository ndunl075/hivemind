/**
 * MCP endpoint (ARCHITECTURE.md §7): stateless Streamable HTTP, JSON responses. Serves `initialize`, `tools/list`,
 * `tools/call` and `ping`; the tools live in tools.ts.
 *
 * Anything else, including Claude Code's `server/discover` probe, is answered with a JSON-RPC error (-32601) in a
 * normal HTTP 200 response, never with a transport-level error. A tool that throws unexpectedly becomes a JSON-RPC
 * -32603 error, not an HTTP 500.
 *
 * All responses go through writeMcpResponse(): one small function, so switching to a single-event SSE stream
 * (the §21 fallback) is a change in one place.
 */
import type { AgentRecord, ToolName } from '../../../../shared/contracts';
import protocol from '../../../../shared/protocol.md';
import { type RoomServices } from '../../services';
import { errorResponse, json } from '../../util';
import { TaskError } from '../tasks';
import { validateSchema } from './schema';
import { TOOLS } from './tools';
import { RpcError, ToolError } from './types';

export { TOOLS } from './tools';
export { RpcError, ToolError, type ToolContext, type ToolDef } from './types';

const SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'hivemind', version: '0.1.0' };

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

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

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function callTool(svc: RoomServices, person: string, id: JsonRpcId, params: Record<string, unknown> | undefined): Promise<unknown> {
  const name = params?.name;
  const rawArgs = params?.arguments ?? {};
  const tool = typeof name === 'string' && Object.hasOwn(TOOLS, name) ? TOOLS[name as ToolName] : undefined;
  if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
  if (!isPlainObject(rawArgs)) return rpcError(id, -32602, 'Invalid params: arguments must be an object.');
  const args = rawArgs;
  let agent: AgentRecord | null = null;
  if (!tool.noMe) {
    const me = args.me;
    if (typeof me !== 'string' || me === '') return { jsonrpc: '2.0', id, result: textResult('`me` is required: pass your callsign.', true) };
    agent = svc.agents.get(me);
    if (!agent || agent.person !== person) {
      return { jsonrpc: '2.0', id, result: textResult(`"${me}" is not your callsign. Use the one in your Hivemind briefing.`, true) };
    }
  }
  const problem = validateSchema(tool.inputSchema, args, 'arguments');
  if (problem) return rpcError(id, -32602, `Invalid params: ${problem}`);
  if (agent) {
    const wasIdle = agent.idleSince !== null;
    svc.agents.touch(agent);
    if (wasIdle) svc.changed();
  }
  try {
    const out = await tool.run({ svc, person, agent }, args);
    return { jsonrpc: '2.0', id, result: textResult(out) };
  } catch (e) {
    if (e instanceof ToolError || e instanceof TaskError) return { jsonrpc: '2.0', id, result: textResult(e.message, true) };
    if (e instanceof RpcError) return rpcError(id, e.code, e.message);
    return rpcError(id, -32603, 'Internal error');
  }
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
          tools: Object.entries(TOOLS).map(([name, t]) => ({
            name, title: t.title, description: t.description, inputSchema: t.inputSchema,
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        },
      };
    case 'tools/call':
      return callTool(svc, person, id, msg.params);
    default:
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

async function safeDispatch(svc: RoomServices, person: string, msg: JsonRpcRequest): Promise<unknown | null> {
  try {
    return await dispatch(svc, person, msg);
  } catch {
    return msg.id === undefined ? null : rpcError(msg.id, -32603, 'Internal error');
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
      const r = isRequest(m) ? await safeDispatch(svc, person, m) : (m && typeof m === 'object' && 'result' in m ? null : rpcError(null, -32600, 'Invalid Request'));
      if (r !== null) out.push(r);
    }
    return writeMcpResponse(out.length > 0 ? out : null);
  }
  if (!isRequest(body)) return json(rpcError(null, -32600, 'Invalid Request'), 400);
  return writeMcpResponse(await safeDispatch(svc, person, body));
}
