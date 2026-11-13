import { ProtocolError } from '@modelcontextprotocol/server';
import { EventsErrorCode } from './errors.js';

/**
 * Outpost's MCP Events routes (Outpost v1.9.0 and later, experimental):
 *
 *   events/list        -> GET  /mcp/events/list
 *   events/subscribe   -> POST /tenants/:tenant_id/mcp/events/subscribe
 *   events/unsubscribe -> POST /tenants/:tenant_id/mcp/events/unsubscribe
 *
 * Outpost verifies the callback, stores the subscription, applies its
 * arguments as a filter, and signs and delivers each matching event. The
 * Outpost TypeScript SDK has no methods for these routes yet, so they're
 * called with fetch.
 */

/** The `mcp_error` Outpost answers with a 422: a JSON-RPC error object to return as is. */
interface McpErrorBody {
  mcp_error?: { code: number; message: string; data?: Record<string, unknown> };
}

export type McpResult = Record<string, unknown>;

export class OutpostMcp {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly log: (message: string) => void = () => {},
  ) {}

  listEvents(params: { cursor?: string | null; limit?: number } = {}): Promise<McpResult> {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit) query.set('limit', String(params.limit));
    const search = query.size > 0 ? `?${query}` : '';
    return this.call('GET', `/mcp/events/list${search}`);
  }

  subscribe(tenantId: string, params: Record<string, unknown>): Promise<McpResult> {
    return this.call('POST', `/tenants/${encodeURIComponent(tenantId)}/mcp/events/subscribe`, params);
  }

  unsubscribe(tenantId: string, params: Record<string, unknown>): Promise<McpResult> {
    return this.call('POST', `/tenants/${encodeURIComponent(tenantId)}/mcp/events/unsubscribe`, params);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<McpResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Subscribe waits for Outpost to verify the callback URL before it answers.
        signal: AbortSignal.timeout(40_000),
      });
    } catch (error) {
      this.log(`Outpost ${method} ${path} failed: ${(error as Error).message}`);
      throw new ProtocolError(EventsErrorCode.InternalError, 'Outpost is unreachable');
    }

    const text = await response.text();
    const json = text ? (JSON.parse(text) as unknown) : {};

    // 200: the MCP result, returned as is.
    if (response.ok) return json as McpResult;

    // 422: an MCP Events error (invalid params, callback verification failed, rate limited, ...).
    const mcpError = (json as McpErrorBody).mcp_error;
    if (mcpError) throw new ProtocolError(mcpError.code, mcpError.message, mcpError.data);

    // 404: MCP Events is off on this Outpost deployment. 503: the event definitions are
    // invalid, or verification is briefly unavailable. Log the detail, keep it from the client.
    this.log(`Outpost ${method} ${path} answered HTTP ${response.status}: ${text.slice(0, 500)}`);
    const message =
      response.status === 404
        ? 'MCP Events is not enabled on this server'
        : response.status === 503
          ? 'MCP Events is temporarily unavailable'
          : 'Internal error';
    throw new ProtocolError(EventsErrorCode.InternalError, message);
  }
}
