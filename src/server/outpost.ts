/*
 * A small client for the Hookdeck Outpost admin API, covering only the calls
 * this demo makes. Paths and payloads follow Outpost's OpenAPI spec
 * (docs/apis/openapi.yaml in hookdeck/outpost). Managed Outpost base URL:
 * https://api.outpost.hookdeck.com/2025-07-01, auth: `Authorization: Bearer <API key>`.
 */

export interface OutpostDestination {
  id: string;
  type: string;
  topics: string[] | '*';
  filter?: Record<string, unknown> | null;
  config: { url: string; custom_headers?: string };
  credentials: { secret?: string; previous_secret?: string; previous_secret_invalid_at?: string };
  metadata?: Record<string, string> | null;
  disabled_at: string | null;
}

export interface OutpostAttempt {
  id: string;
  status: 'success' | 'failed';
  time: string;
  code?: string;
}

export interface PublishRequest {
  id: string;
  tenant_id: string;
  topic: string;
  eligible_for_retry: boolean;
  time?: string;
  metadata?: Record<string, string>;
  data: Record<string, unknown>;
}

export interface PublishResponse {
  id: string;
  duplicate: boolean;
  destination_ids: string[];
}

export class OutpostError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    operation: string,
  ) {
    super(`Outpost ${operation} failed with HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

export class OutpostClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) throw new OutpostError(response.status, text, `${method} ${path}`);
    return { status: response.status, data: (text ? JSON.parse(text) : undefined) as T };
  }

  private static path(...segments: string[]) {
    return segments.map((segment) => `/${encodeURIComponent(segment)}`).join('');
  }

  async upsertTenant(tenantId: string, metadata?: Record<string, string>): Promise<void> {
    await this.call('PUT', OutpostClient.path('tenants', tenantId), metadata ? { metadata } : undefined);
  }

  async createDestination(tenantId: string, destination: Record<string, unknown>): Promise<OutpostDestination> {
    return (await this.call<OutpostDestination>('POST', OutpostClient.path('tenants', tenantId, 'destinations'), destination)).data;
  }

  async updateDestination(tenantId: string, destinationId: string, patch: Record<string, unknown>): Promise<OutpostDestination> {
    const path = OutpostClient.path('tenants', tenantId, 'destinations', destinationId);
    return (await this.call<OutpostDestination>('PATCH', path, patch)).data;
  }

  async getDestination(tenantId: string, destinationId: string): Promise<OutpostDestination | null> {
    try {
      return (await this.call<OutpostDestination>('GET', OutpostClient.path('tenants', tenantId, 'destinations', destinationId))).data;
    } catch (error) {
      if (error instanceof OutpostError && error.status === 404) return null;
      throw error;
    }
  }

  async enableDestination(tenantId: string, destinationId: string): Promise<void> {
    await this.call('PUT', OutpostClient.path('tenants', tenantId, 'destinations', destinationId, 'enable'));
  }

  /** Returns false when the destination (or tenant) no longer exists. */
  async deleteDestination(tenantId: string, destinationId: string): Promise<boolean> {
    try {
      await this.call('DELETE', OutpostClient.path('tenants', tenantId, 'destinations', destinationId));
      return true;
    } catch (error) {
      if (error instanceof OutpostError && error.status === 404) return false;
      throw error;
    }
  }

  async latestAttempt(tenantId: string, destinationId: string): Promise<OutpostAttempt | null> {
    const path = `${OutpostClient.path('tenants', tenantId, 'destinations', destinationId, 'attempts')}?limit=1`;
    const { data } = await this.call<{ models?: OutpostAttempt[] }>('GET', path);
    return data?.models?.[0] ?? null;
  }

  async publish(event: PublishRequest): Promise<PublishResponse> {
    return (await this.call<PublishResponse>('POST', '/publish', event)).data;
  }

  /** Managed Outpost only. */
  async getConfig(): Promise<Record<string, string>> {
    return (await this.call<Record<string, string>>('GET', '/config')).data;
  }

  /** Managed Outpost only. */
  async updateConfig(values: Record<string, string | null>): Promise<Record<string, string>> {
    return (await this.call<Record<string, string>>('PATCH', '/config', values)).data;
  }
}
