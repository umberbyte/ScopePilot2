import { UnavailableCapability } from '@scopepilot2/core';
/**
 * Production engine composition. Runtime code never falls back to simulation
 * fixtures: exploration uses Playwright and scans use a real ZAP daemon.
 */
import { existsSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import type { ActiveScanEnginePort, ExplorationPort, LoginExecutorPort, NucleiScanPort } from '@scopepilot2/core';
import type { ActiveScanRequest, EngineAlert, EngineCapabilitySnapshot, EngineProgress } from '@scopepilot2/contracts';
import { NodeFuzzTransport } from './fuzz-transport.ts';
import { InteractshCliProvider } from './interactsh-provider.ts';
import { PlaywrightLoginExecutor } from './login-executor.ts';
import { NodeRepeaterTransport } from './repeater-transport.ts';
import { NodeSequencerTransport } from './sequencer-transport.ts';
import { NodeWebSocketTransport } from './websocket-transport.ts';
import { NodeHttp2Transport } from './http2-transport.ts';
import { PlaywrightDomObserver } from './dom-observer.ts';
import { PlaywrightInteractiveBrowser } from './interactive-browser.ts';
import {
  ZapEngineAdapter,
  type RecoveredZapHttpEvidence,
  type ZapHttpEvidenceLookup,
} from './zap-engine.ts';
import { PlaywrightExplorerAdapter } from './playwright-explorer.ts';
import { NucleiRunner } from './nuclei-runner.ts';
import { NodeWorkflowScanTransport, type NodeWorkflowScanTransportOptions } from './workflow-scan-transport.ts';
import { createSecurityFixtureAdapters } from './security-fixture.ts';

const DEFAULT_ZAP_BASE_URL = 'http://127.0.0.1:8080';

export interface EngineSelection {
  readonly zapBaseUrl: string;
  readonly zapBaseUrlWasExplicit: boolean;
  readonly explorerAllowedOrigins: readonly string[];
  readonly oastServerUrl?: string;
  readonly interactshConfigPath?: string;
  readonly zapExecutable?: string;
  readonly nucleiExecutable?: string;
  readonly nucleiTemplateManifest?: string;
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
  const nucleiExecutable = env['SCOPEPILOT_NUCLEI_EXECUTABLE']?.trim();
  const nucleiTemplateManifest = env['SCOPEPILOT_NUCLEI_TEMPLATE_MANIFEST']?.trim();
  return {
    zapBaseUrl: explicitZap || DEFAULT_ZAP_BASE_URL,
    zapBaseUrlWasExplicit: Boolean(explicitZap),
    explorerAllowedOrigins: canonicalOrigins(allowedOrigins),
    ...(oastServerUrl ? { oastServerUrl } : {}),
    ...(interactshConfigPath ? { interactshConfigPath } : {}),
    ...(zapExecutable ? { zapExecutable } : {}),
    ...(nucleiExecutable ? { nucleiExecutable } : {}),
    ...(nucleiTemplateManifest ? { nucleiTemplateManifest } : {}),
  };
}

export function createScanEngine(selection: EngineSelection): ActiveScanEnginePort {
  return new ZapEngineAdapter({ baseUrl: selection.zapBaseUrl });
}

export function createExplorerEngine(
  selection: EngineSelection,
  proxyServer?: string,
  beforeSessionObservation?: (url: string) => Promise<void>,
): PlaywrightExplorerAdapter {
  return new PlaywrightExplorerAdapter({
    scope: { allowedOrigins: selection.explorerAllowedOrigins, deniedOrigins: [] },
    ...(proxyServer === undefined ? {} : { proxyServer }),
    ...(beforeSessionObservation === undefined ? {} : { beforeSessionObservation }),
  });
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
  readonly nucleiVersion?: string;
}): readonly EngineCapabilitySnapshot[] {
  const unsupported = {
    preSendScopeEnforcement: 'Unsupported', stopControl: 'Unsupported', budgetLease: 'Unsupported', rateLimit: 'Unsupported',
  } as const;
  return [
    {
      engineKind: 'node-http', engineVersion: 'scopepilot-workflow-transport-v1', source: 'measured',
      guaranteeLevels: { preSendScopeEnforcement: 'Enforced', stopControl: 'Enforced', budgetLease: 'Enforced', rateLimit: 'Enforced' },
      maxOvershootRatio: 0, measuredAt: input.measuredAt,
    },
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
    ...(input.nucleiVersion === undefined ? [] : [{
      engineKind: 'nuclei' as const,
      engineVersion: input.nucleiVersion,
      source: 'measured' as const,
      guaranteeLevels: {
        preSendScopeEnforcement: 'Delegated' as const,
        stopControl: 'Delegated' as const,
        budgetLease: 'Delegated' as const,
        rateLimit: 'Delegated' as const,
      },
      maxOvershootRatio: 0.05,
      measuredAt: input.measuredAt,
    }]),
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
    // The short timeout is only for bounded startup probing. Reusing this
    // adapter for a real scan makes larger alert/message responses fail after
    // 1.5 seconds with `AbortError: This operation was aborted`.
    const probe = new ZapEngineAdapter({ baseUrl, timeoutMs: 1_500 });
    try {
      await probe.resolvedVersion();
      const runtime = new ZapEngineAdapter({ baseUrl });
      await runtime.resolvedVersion();
      return runtime;
    } catch {
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  return null;
}

/**
 * Pick an ephemeral loopback port for a ZAP daemon owned by ScopePilot.
 * Port 8080 is also a common target application port (for example a local
 * a fast local test application), so the result must not depend on which process starts first.
 */
export async function resolveOwnedZapBaseUrl(preferredBaseUrl: string): Promise<string> {
  const preferred = new URL(preferredBaseUrl);
  const bind = async (port: number): Promise<number> => await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(port, preferred.hostname, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('failed to resolve the local ZAP listener address'));
        return;
      }
      server.close((cause) => cause === undefined ? resolve(address.port) : reject(cause));
    });
  });
  const availablePort = await bind(0);
  return `${preferred.protocol}//${preferred.hostname}:${String(availablePort)}`;
}

async function resolveZap(selection: EngineSelection): Promise<{
  readonly engine: ActiveScanEnginePort;
  readonly available: boolean;
  readonly baseUrl: string;
  readonly ownedProcess?: ChildProcess;
}> {
  const existing = await waitForZap(selection.zapBaseUrl, 1);
  if (existing !== null) return { engine: existing, available: true, baseUrl: selection.zapBaseUrl };
  if (selection.zapBaseUrlWasExplicit) {
    return { engine: new UnavailableActiveScanEngine(`configured endpoint ${selection.zapBaseUrl} did not respond`), available: false, baseUrl: selection.zapBaseUrl };
  }
  const executable = zapCandidates(selection).find((candidate) => existsSync(candidate));
  if (executable === undefined) {
    return { engine: new UnavailableActiveScanEngine('install ZAP or set SCOPEPILOT_ZAP_BASE_URL'), available: false, baseUrl: selection.zapBaseUrl };
  }
  const ownedBaseUrl = await resolveOwnedZapBaseUrl(selection.zapBaseUrl);
  const endpoint = new URL(ownedBaseUrl);
  const child = spawn(executable, [
    '-daemon', '-host', endpoint.hostname, '-port', endpoint.port || '8080',
    '-config', 'api.disablekey=true',
    '-config', `api.addrs.addr.name=${endpoint.hostname}`,
    '-config', 'api.addrs.addr.regex=false',
  ], { cwd: dirname(executable), windowsHide: true, stdio: 'ignore' });
  // Keep desktop startup bounded while allowing a cold ZAP 2.17 installation to load its
  // add-ons.  The previous ~17.5 second window was shorter than the ~22 seconds measured on
  // Windows, so a healthy daemon was marked Unsupported immediately before it began listening.
  const started = await waitForZap(ownedBaseUrl, 120);
  if (started !== null) return { engine: started, available: true, baseUrl: ownedBaseUrl, ownedProcess: child };
  child.kill();
  return { engine: new UnavailableActiveScanEngine(`daemon did not become ready at ${ownedBaseUrl}`), available: false, baseUrl: ownedBaseUrl };
}

async function resolveNuclei(selection: EngineSelection): Promise<NucleiScanPort | undefined> {
  // A binary alone is not a safe capability. Production execution is exposed only
  // when a reviewed, hash-pinned HTTP template manifest is configured as well.
  if (selection.nucleiExecutable === undefined || selection.nucleiTemplateManifest === undefined) return undefined;
  const runner = new NucleiRunner({
    command: selection.nucleiExecutable,
    templateManifestPath: selection.nucleiTemplateManifest,
  });
  try {
    const reviewed = await runner.verifyTemplateBundle();
    const engineVersion = await runner.version();
    return {
      engineVersion,
      templateBundleHash: reviewed.bundleHash,
      run: async (input) => {
        const result = await runner.run(input);
        if (result.templateBundleHash !== reviewed.bundleHash) {
          throw new Error('reviewed Nuclei template bundle changed after capability verification');
        }
        return { lines: result.lines };
      },
    };
  } catch {
    return undefined;
  }
}

export interface ComposedEngines {
  readonly mode: 'real';
  readonly explorer: ExplorationPort;
  readonly scanEngine: ActiveScanEnginePort;
  readonly nucleiRunner?: NucleiScanPort;
  readonly loginExecutor: LoginExecutorPort;
  readonly workflowScanTransportFactory: (options: NodeWorkflowScanTransportOptions) => import('@scopepilot2/core').WorkflowScanTransport;
  readonly repeaterTransport: import('@scopepilot2/core').RepeaterTransportPort;
  readonly fuzzTransport: import('@scopepilot2/core').FuzzTransportPort;
  readonly sequencerTransport: import('@scopepilot2/core').SequencerTransportPort;
  readonly oastProvider: import('@scopepilot2/core').OastProviderPort | UnavailableCapability;
  readonly webSocketTransport: import('@scopepilot2/core').WebSocketTransportPort;
  readonly advancedTransport: import('@scopepilot2/core').AdvancedTransportPort;
  readonly domObserver: import('@scopepilot2/core').DomObservationPort;
  readonly interactiveBrowser: import('@scopepilot2/core').InteractiveBrowserPort;
  readonly otpInbox?: import('@scopepilot2/core').OtpInboxPort;
  readonly samlFixture?: import('@scopepilot2/core').SamlFixturePort;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  readonly runtimeBundleHash: string;
  readonly recoverHttpExchanges?: (
    lookups: readonly ZapHttpEvidenceLookup[],
  ) => Promise<readonly (RecoveredZapHttpEvidence | null)[]>;
  updateExplorationScope(scope: { readonly allowedOrigins: readonly string[]; readonly deniedOrigins: readonly string[] }): void;
  close(): Promise<void>;
}

export async function composeEngines(
  env: Readonly<Record<string, string | undefined>> = process.env,
  allowedOrigins: readonly string[] = [],
): Promise<ComposedEngines> {
  const selection = resolveEngineSelection(env, allowedOrigins);
  const zap = await resolveZap(selection);
  const zapAdapter = zap.available && zap.engine instanceof ZapEngineAdapter ? zap.engine : undefined;
  const explorer = createExplorerEngine(
    selection,
    zap.available ? zap.baseUrl : undefined,
    zapAdapter === undefined ? undefined : async (url) => await zapAdapter.unsetActiveHttpSession(url),
  );
  const nucleiRunner = await resolveNuclei(selection);
  const loginExecutor = new PlaywrightLoginExecutor();
  const repeaterTransport = new NodeRepeaterTransport();
  const fuzzTransport = new NodeFuzzTransport();
  const sequencerTransport = new NodeSequencerTransport();
  const webSocketTransport = new NodeWebSocketTransport();
  const advancedTransport = new NodeHttp2Transport();
  const domObserver = new PlaywrightDomObserver();
  const interactiveBrowser = new PlaywrightInteractiveBrowser();
  const securityFixture = createSecurityFixtureAdapters(env);
  const interactshProvider = selection.oastServerUrl && selection.interactshConfigPath
    ? new InteractshCliProvider({ serverUrl: selection.oastServerUrl, configPath: selection.interactshConfigPath })
    : undefined;
  const oastProvider = interactshProvider ?? new UnavailableCapability('OAST provider is not configured');
  return {
    mode: 'real', explorer, scanEngine: zap.engine, ...(nucleiRunner === undefined ? {} : { nucleiRunner }), loginExecutor,
    workflowScanTransportFactory: (options) => new NodeWorkflowScanTransport(options),
    // Login runs in an isolated browser without the ZAP proxy.  ZAP may retain an
    // active HTTP session from a previous scan and inject that session into a new
    // browser, causing the login page (and its fields) to disappear.  The scan
    // adapter receives the freshly authenticated cookies explicitly instead.
    repeaterTransport, fuzzTransport,
    sequencerTransport, oastProvider, webSocketTransport, advancedTransport, domObserver, interactiveBrowser,
    ...(securityFixture === undefined ? {} : { otpInbox: securityFixture.otpInbox, samlFixture: securityFixture.samlFixture }),
    capabilities: capabilitySnapshots({
      zapVersion: zap.engine.engineVersion, zapAvailable: zap.available,
      explorerVersion: explorer.engineVersion, measuredAt: new Date().toISOString(),
      ...(nucleiRunner === undefined ? {} : { nucleiVersion: nucleiRunner.engineVersion }),
    }),
    runtimeBundleHash: `production-engines:${explorer.engineVersion}:${zap.engine.engineVersion}:${nucleiRunner?.engineVersion ?? 'nuclei-unavailable'}:${nucleiRunner?.templateBundleHash ?? 'templates-unavailable'}:${securityFixture === undefined ? 'security-fixture-unavailable' : 'security-fixture-v1'}`,
    ...(zapAdapter === undefined ? {} : {
      recoverHttpExchanges: async (lookups: readonly ZapHttpEvidenceLookup[]) => await zapAdapter.recoverHttpExchanges(lookups),
    }),
    updateExplorationScope: (scope) => explorer.updateScope(scope),
    close: async () => {
      await explorer.close();
      await loginExecutor.close();
      await interactshProvider?.close();
      if (zap.ownedProcess !== undefined) {
        await fetch(`${zap.baseUrl}/JSON/core/action/shutdown/`).catch(() => undefined);
        zap.ownedProcess.kill();
      }
    },
  };
}
