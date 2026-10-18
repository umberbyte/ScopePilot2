/**
 * `scopepilot capabilities` — Core API の能力表 (engine 別保証等級・版) を照会する。
 * `--api` 指定時は外部 Core API、無指定時は in-process (simulation harness) に問い合わせる。
 */
import type { EngineCapabilitySnapshot } from '@scopepilot2/contracts';
import { createCoreApiServer } from '@scopepilot2/core';
import { createHarness, FIXTURE_OPERATOR } from '@scopepilot2/simulation';
import type { OutputWriters } from './output-formatter.ts';

export async function runCapabilities(options: { apiUrl?: string }, writers: OutputWriters): Promise<number> {
  const fetchCapabilities = async (baseUrl: string): Promise<readonly EngineCapabilitySnapshot[]> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/capabilities`);
    } catch {
      writers.stderr(`error: Core API at ${baseUrl} is unreachable`);
      return [];
    }
    if (!response.ok) {
      writers.stderr(`error: GET /api/capabilities failed: HTTP ${response.status}`);
      return [];
    }
    const body = (await response.json()) as { capabilities?: readonly EngineCapabilitySnapshot[] };
    return body.capabilities ?? [];
  };

  if (options.apiUrl !== undefined) {
    const capabilities = await fetchCapabilities(options.apiUrl);
    if (capabilities.length === 0) {
      return 7;
    }
    writers.stdout(JSON.stringify({ schemaVersion: 'scopepilot2.capabilities.v1', source: options.apiUrl, capabilities }, null, 2));
    return 0;
  }

  const harness = createHarness();
  const server = createCoreApiServer({ service: harness.service, operator: FIXTURE_OPERATOR });
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP address for the core api server');
    }
    const capabilities = await fetchCapabilities(`http://127.0.0.1:${address.port}`);
    if (capabilities.length === 0) {
      return 7;
    }
    writers.stdout(JSON.stringify({ schemaVersion: 'scopepilot2.capabilities.v1', source: 'in-process (fixture)', capabilities }, null, 2));
    return 0;
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
}
