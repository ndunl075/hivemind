/** Shared types of the MCP feature. Kept apart from index.ts and tools.ts so neither imports the other. */
import type { AgentRecord } from '../../../../shared/contracts';
import type { RoomServices } from '../../services';

/** An error the tool wants shown to the agent (isError result), not a protocol error. */
export class ToolError extends Error {}

/** A JSON-RPC protocol error with a code, for malformed requests (-32602 invalid params). */
export class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export interface ToolContext {
  svc: RoomServices;
  person: string;
  /** The caller. Null only for tools that take no `me` (register). */
  agent: AgentRecord | null;
}

export interface ToolDef {
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** MCP tool annotations: hints for clients (a read-only tool needs no permission prompt). */
  annotations?: Record<string, boolean>;
  /** Tools that don't take `me` (register). */
  noMe?: boolean;
  run(tc: ToolContext, args: Record<string, unknown>): Promise<unknown> | unknown;
}
