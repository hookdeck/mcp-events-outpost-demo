import { ProtocolError } from '@modelcontextprotocol/server';

/**
 * JSON-RPC error codes this server raises or checks. Errors from Outpost's MCP
 * routes (invalid params, callback verification, rate limits) arrive as an
 * `mcp_error` and are returned unchanged (see outpost-mcp.ts).
 */
export const EventsErrorCode = {
  InvalidParams: -32602,
  /** SEP-3415's NotFound, as Outpost answers it. */
  NotFound: -32023,
  Forbidden: -32012,
  InternalError: -32603,
} as const;

export const invalidParams = (message: string) => new ProtocolError(EventsErrorCode.InvalidParams, message);

export const forbidden = (message = 'An authenticated principal is required') =>
  new ProtocolError(EventsErrorCode.Forbidden, message);
