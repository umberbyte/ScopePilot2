/**
 * Production engine composition. Runtime code never falls back to simulation
 * fixtures: exploration uses Playwright and scans use a real ZAP daemon.
 */
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import type { ActiveScanEnginePort, ExplorationPort, LoginExecutorPort } from '@scopepilot2/core';
import type { ActiveScanRequest, EngineAlert, EngineCapabilitySnapshot, EngineProgress } from '@scopepilot2/contracts';
import { NodeFuzzTransport } from './fuzz-transport.ts';
import { InteractshCliProvider } from './interactsh-provider.ts';
import { PlaywrightLoginExecutor } from './login-executor.ts';
import { NodeRepeaterTransport } from './repeater-transport.ts';
import { NodeSequencerTransport } from './sequencer-transport.ts';
import { NodeWebSocketTransport } from './websocket-transport.ts';
import { NodeHttp2Transport } from './http2-transport.ts';
import { PlaywrightDomObserver } from './dom-observer.ts';
import { ZapEngineAdapter } from './zap-engine.ts';
import { PlaywrightExplorerAdapter } from './playwright-explorer.ts';

const DEFAULT_ZAP_BASE_URL = 'http://127.0.0.1:8080';

export interface EngineSelection {
  readonly zapBaseUrl: string;
  readonly zapBaseUrlWasExplicit: boolean;
  readonly explorerAllowedOrigins: readonly string[];
  readonly oastServerUrl?: string;
  readonly interactshConfigPath?: string;
  readonly zapExecutable?: string;
}

function canonicalOrigins(origins: readonly string[]): readonly string[] {
  return [...new Set(origins.map((origin) => {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`exploration origin must use http(s): ${origin}`);
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') throw new Error(`exploration scope must contain origins, not URLs: ${origin}`);
    return parsed.origin;
  }))];
}

export function resolveEngineSelection(
  env: Readonly<Record<string, string | undefined>> = process.env,
  allowedOrigins: readonly string[] = [],
): EngineSelection {
  const explicitZap = env['SCOPEPILOT_ZAP_BASE_URL']?.trim();
  const oastServerUrl = env['SCOPEPILOT_OAST_SERVER_URL']?.trim();
  const interactshConfigPath = env['SCOPEPILOT_INTERACTSH_CONFIG']?.trim();
  if (oastServerUrl && !interactshConfigPath) throw new Error('SCOPEPILOT_OAST_SERVER_URL requires SCOPEPILOT_INTERACTSH_CONFIG');
  const zapExecutable = env['SCOPEPILOT_ZAP_EXECUTABLE']?.trim();
  return {
    zapBaseUrl: explicitZap || DEFAULT_ZAP_BASE_URL,
    zapBaseUrlWasExplicit: Boolean(explicitZap),
    explorerAllowedOrigins: canonicalOrigins(allowedOrigins),
    ...(oastServerUrl ? { oastServerUrl } : {}),
    ...(interactshConfigPath ? { interactshConfigPath } : {}),
    ...(zapExecutable ? { zapExecutable } : {}),
  };
}

export function createScanEngine(selection: EngineSelection): ActiveScanEnginePort {
  return new ZapEngineAdapter({ baseUrl: selection.zapBaseUrl });
}

export function createExplorerEngine(selection: EngineSelection): PlaywrightExplorerAdapter {
  return new PlaywrightExplorerAdapter({ scope: { allowedOrigins: selection.explorerAllowedOrigins, deniedOrigins: [] } });
}

class UnavailableActiveScanEngine implements ActiveScanEnginePort {
  readonly engineVersion = 'zap (unavailable)';
  private readonly reason: string;
  constructor(reason: string) { this.reason = reason; }
  private fail(): never { throw new Error(`ZAP is unavailable: ${this.reason}`); }
  async start(_request: ActiveScanRequest): Promise<string> { return this.fail(); }
  async progress(_engineRunId: string): Promise<EngineProgress> { return this.fail(); }
  async alerts(_engineRunId: string, _cursor: number): Promise<{ readonly alerts: readonly EngineAlert[]; readonly nextCursor: number }> { return this.fail(); }
  async stop(_engineRunId: string): Promise<void> { this.fail(); }
}

function capabilitySnapshots(input: {
  readonly zapVersion: string;
  readonly zapAvailable: boolean;
  readonly explorerVersion: string;
  readonly measuredAt: string;
}): readonly EngineCapabilitySnapshot[] {
  const unsupported = {
    preSendScopeEnforcement: 'Unsupported', stopControl: 'Unsupported', budgetLease: 'Unsupported', rateLimit: 'Unsupported',
  } as const;
  return [
    {
      engineKind: 'playwright', engineVersion: input.explorerVersion, source: 'measured',
      guaranteeLevels: { preSendScopeEnforcement: 'Enforced', stopControl: 'Enforced', budgetLease: 'Enforced', rateLimit: 'Enforced' },
      maxOvershootRatio: 0, measuredAt: input.measuredAt,
    },
    {
      engineKind: 'zap', engineVersion: input.zapVersion, source: 'measured',
      guaranteeLevels: input.zapAvailable
        ? { preSendScopeEnforcement: 'Delegated', stopControl: 'Delegated', budgetLease: 'Delegated', rateLimit: 'Delegated' }
        : unsupported,
      maxOvershootRatio: input.zapAvailable ? 0.05 : 0, measuredAt: input.measuredAt,
    },
  ];
}

/** Kept as a small public helper for capability-table tests and extensions. */
export function createCapabilitySnapshots(input: {
  readonly zap: { readonly engineVersion: string; readonly real: boolean };
  readonly explorer: { readonly engineVersion: string; readonly real: boolean };
  readonly measuredAt: string;
}): readonly EngineCapabilitySnapshot[] {
  return capabilitySnapshots({
    zapVersion: input.zap.engineVersion, zapAvailable: input.zap.real,
    explorerVersion: input.explorer.engineVersion, measuredAt: input.measuredAt,
  });
}

function zapCandidates(selection: EngineSelection): readonly string[] {
  return [...new Set([
    selection.zapExecutable,
    'C:\\Program Files\\ZAP\\Zed Attack Proxy\\ZAP.exe',
    'C:\\Program Files (x86)\\ZAP\\Zed Attack Proxy\\ZAP.exe',
  ].filter((entry): entry is string => Boolean(entry)))];
}

async function waitForZap(baseUrl: string, attempts: number): Promise<ZapEngineAdapter | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const adapter = new ZapEngineAdapter({ baseUrl, timeoutMs: 1_500 });
    try {
      await adapter.resolvedVersion();
      return adapter;
    } catch {
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return null;
}

async function resolveZap(selection: EngineSelection): Promise<{
  readonly engine: ActiveScanEnginePort;
  readonly available: boolean;
  readonly ownedProcess?: ChildProcess;
}> {
  const existing = await waitForZap(selection.zapBaseUrl, 1);
  if (existing !== null) return { engine: existing, available: true };
  if (selection.zapBaseUrlWasExplicit) {
    return { engine: new UnavailableActiveScanEngine(`configured endpoint ${selection.zapBaseUrl} did not respond`), available: false };
  }
  const executable = zapCandidates(selection).find((candidate) => existsSync(candidate));
  if (executable === undefined) {
    return { engine: new UnavailableActiveScanEngine('install ZAP or set SCOPEPILOT_ZAP_BASE_URL'), available: false };
  }
  const endpoint = new URL(selection.zapBaseUrl);
  const child = spawn(executable, [
    '-daemon', '-host', endpoint.hostname, '-port', endpoint.port || '8080',
    '-config', 'api.disablekey=true',
    '-config', `api.addrs.addr.name=${endpoint.hostname}`,
    '-config', 'api.addrs.addr.regex=false',
  ], { cwd: dirname(executable), windowsHide: true, stdio: 'ignore' });
  const started = await waitForZap(selection.zapBaseUrl, 90);
  if (started !== null) return { engine: started, available: true, ownedProcess: child };
  child.kill();
  return { engine: new UnavailableActiveScanEngine(`daemon did not become ready at ${selection.zapBaseUrl}`), available: false };
}

export interface ComposedEngines {
  readonly mode: 'real';
  readonly explorer: ExplorationPort;
  readonly scanEngine: ActiveScanEnginePort;
  readonly loginExecutor: LoginExecutorPort;
  readonly repeaterTransport: import('@scopepilot2/core').RepeaterTransportPort;
  readonly fuzzTransport: import('@scopepilot2/core').FuzzTransportPort;
  readonly sequencerTransport: import('@scopepilot2/core').SequencerTransportPort;
  readonly oastProvider: import('@scopepilot2/core').OastProviderPort;
  readonly webSocketTransport: import('@scopepilot2/core').WebSocketTransportPort;
  readonly advancedTransport: import('@scopepilot2/core').AdvancedTransportPort;
  readonly domObserver: import('@scopepilot2/core').DomObservationPort;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  readonly runtimeBundleHash: string;
  updateExplorationScope(scope: { readonly allowedOrigins: readonly string[]; readonly deniedOrigins: readonly string[] }): void;
  close(): Promise<void>;
}

export async function composeEngines(
  env: Readonly<Record<string, string | undefined>> = process.env,
  allowedOrigins: readonly string[] = [],
): Promise<ComposedEngines> {
  const selection = resolveEngineSelection(env, allowedOrigins);
  const explorer = createExplorerEngine(selection);
  const zap = await resolveZap(selection);
  const loginExecutor = new PlaywrightLoginExecutor();
  const repeaterTransport = new NodeRepeaterTransport();
  const fuzzTransport = new NodeFuzzTransport();
  const sequencerTransport = new NodeSequencerTransport();
  const webSocketTransport = new NodeWebSocketTransport();
  const advancedTransport = new NodeHttp2Transport();
  const domObserver = new PlaywrightDomObserver();
  const interactshProvider = selection.oastServerUrl && selection.interactshConfigPath
    ? new InteractshCliProvider({ serverUrl: selection.oastServerUrl, configPath: selection.interactshConfigPath })
    : undefined;
  const oastProvider: import('@scopepilot2/core').OastProviderPort = interactshProvider ?? {
    supportedProtocols: [], async startSession(): Promise<never> { throw new Error('OAST provider is not configured'); },
  };
  return {
    mode: 'real', explorer, scanEngine: zap.engine, loginExecutor, repeaterTransport, fuzzTransport,
    sequencerTransport, oastProvider, webSocketTransport, advancedTransport, domObserver,
    capabilities: capabilitySnapshots({
      zapVersion: zap.engine.engineVersion, zapAvailable: zap.available,
      explorerVersion: explorer.engineVersion, measuredAt: new Date().toISOString(),
    }),
    runtimeBundleHash: `production-engines:${explorer.engineVersion}:${zap.engine.engineVersion}`,
    updateExplorationScope: (scope) => explorer.updateScope(scope),
    close: async () => {
      await explorer.close();
      await loginExecutor.close();
      await interactshProvider?.close();
      if (zap.ownedProcess !== undefined) {
        await fetch(`${selection.zapBaseUrl}/JSON/core/action/shutdown/`).catch(() => undefined);
        zap.ownedProcess.kill();
      }
    },
  };
}
