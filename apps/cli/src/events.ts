/**
 * `scopepilot events` — 監査 event を NDJSON で stdout へ出力する (design/19 §3)。
 * `--since N` は cursor、`--api <url>` は接続先 Core API。無指定時は in-process。
 */
import { createCoreApiServer } from '@scopepilot2/core';
import { createHarness, FIXTURE_OPERATOR } from '@scopepilot2/simulation';
import type { OutputWriters } from './output-formatter.ts';

export async function runEvents(options: { apiUrl?: string; since?: number }, writers: OutputWriters): Promise<number> {
  const fetchLines = async (baseUrl: string, since: number): Promise<string[]> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/events?since=${since}`);
    } catch {
      writers.stderr(`error: Core API at ${baseUrl} is unreachable`);
      return [];
    }
    if (!response.ok) {
      writers.stderr(`error: GET /api/events failed: HTTP ${response.status}`);
      return [];
    }
    const text = await response.text();
    return text.split('\n').filter((line) => line !== '');
  };

  const since = options.since ?? 0;
  let lines: readonly string[] | null;
  if (options.apiUrl !== undefined) {
    lines = await fetchLines(options.apiUrl, since);
  } else {
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
      lines = await fetchLines(`http://127.0.0.1:${address.port}`, since);
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  }
  if (lines === null) {
    return 7;
  }
  for (const line of lines) {
    writers.stdout(line);
  }
  return 0;
}
