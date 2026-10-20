/**
 * engine 構成の解決。fixture (simulation) と実 adapter の切替を環境変数で行う。
 * 秘密値 (ZAP API key) は環境変数のみで受け、argv・設定 file に置かない (F21-UT-007)。
 * 実行環境に ZAP が無ければ fixture のまま — 実 engine 指定は明示的な opt-in。
 *
 * 環境変数:
 * - SCOPEPILOT_ZAP_BASE_URL: 実 ZAP daemon の API base (例 http://127.0.0.1:8090)。
 *   設定時のみ能動診断を ZAP へ委譲 (Delegated)。
 * - SCOPEPILOT_EXPLORER: 'playwright' で実 browser 探索 (Enforced)。既定は fixture。
 *   実探索は許可 origin を SCOPEPILOT_EXPLORER_ALLOWED_ORIGINS (カンマ区切り・
 *   http(s) origin) に明示させる — adapter 入口の送信前拒否はこの origin 集合に
 *   対して効く (core の案件 scope とは別の防御線)。
 * - SCOPEPILOT_ZAP_API_KEY: ZAP API key (adapter が直接読む)。
 * - SCOPEPILOT_OAST_SERVER_URL: 明示登録した self-host Interactsh HTTPS origin。
 * - SCOPEPILOT_INTERACTSH_CONFIG: auth token 等を持つ公式 client config file。
 */
import type { ActiveScanEnginePort, ExplorationPort, LoginExecutorPort } from '@scopepilot2/core';
import type { EngineCapabilitySnapshot } from '@scopepilot2/contracts';
import { FixtureExplorer, FixtureZapEngine } from '@scopepilot2/simulation';
import { NodeFuzzTransport } from './fuzz-transport.ts';
import { InteractshCliProvider } from './interactsh-provider.ts';
import { PlaywrightLoginExecutor } from './login-executor.ts';
import { NodeRepeaterTransport } from './repeater-transport.ts';
import { NodeSequencerTransport } from './sequencer-transport.ts';
import { NodeWebSocketTransport } from './websocket-transport.ts';
import { ZapEngineAdapter } from './zap-engine.ts';
import { PlaywrightExplorerAdapter } from './playwright-explorer.ts';

export interface EngineSelection {
  readonly mode: 'fixture' | 'zap';
  readonly zapBaseUrl?: string;
  readonly explorer: 'fixture' | 'playwright';
  /** 実探索の許可 origin (explorer=playwright のとき必須)。 */
  readonly explorerAllowedOrigins?: readonly string[];
  readonly oastServerUrl?: string;
  readonly interactshConfigPath?: string;
}

/** 環境変数から engine 選択を解決する。SCOPEPILOT_ZAP_BASE_URL があるときのみ実 ZAP。 */
export function resolveEngineSelection(env: Readonly<Record<string, string | undefined>> = process.env): EngineSelection {
  const zapBaseUrl = env['SCOPEPILOT_ZAP_BASE_URL'];
  const useZap = zapBaseUrl !== undefined && zapBaseUrl !== '';
  const oastServerUrl = env['SCOPEPILOT_OAST_SERVER_URL'];
  const interactshConfigPath = env['SCOPEPILOT_INTERACTSH_CONFIG'];
  const useOast = oastServerUrl !== undefined && oastServerUrl !== '';
  if (useOast && (interactshConfigPath === undefined || interactshConfigPath === '')) {
    throw new Error('SCOPEPILOT_OAST_SERVER_URL requires SCOPEPILOT_INTERACTSH_CONFIG');
  }
  const oast = useOast && interactshConfigPath !== undefined
    ? { oastServerUrl, interactshConfigPath }
    : {};
  if (env['SCOPEPILOT_EXPLORER'] === 'playwright') {
    const raw = env['SCOPEPILOT_EXPLORER_ALLOWED_ORIGINS'] ?? '';
    const origins = raw.split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
    if (origins.length === 0) {
      throw new Error('SCOPEPILOT_EXPLORER=playwright requires SCOPEPILOT_EXPLORER_ALLOWED_ORIGINS (comma-separated http(s) origins)');
    }
    for (const origin of origins) {
      if (!/^https?:\/\/[^/]+\/?$/.test(origin)) {
        throw new Error(`SCOPEPILOT_EXPLORER_ALLOWED_ORIGINS must be http(s) origins: ${origin}`);
      }
    }
    if (useZap && zapBaseUrl !== undefined) {
      return { mode: 'zap', zapBaseUrl, explorer: 'playwright', explorerAllowedOrigins: origins, ...oast };
    }
    return { mode: 'fixture', explorer: 'playwright', explorerAllowedOrigins: origins, ...oast };
  }
  if (useZap && zapBaseUrl !== undefined) {
    return { mode: 'zap', zapBaseUrl, explorer: 'fixture', ...oast };
  }
  return { mode: 'fixture', explorer: 'fixture', ...oast };
}

/** 選択に応じた能動診断 engine を組み立てる。fixture は simulation の固定実装。 */
export function createScanEngine(selection: EngineSelection = resolveEngineSelection()): ActiveScanEnginePort {
  if (selection.mode === 'zap' && selection.zapBaseUrl !== undefined) {
    return new ZapEngineAdapter({ baseUrl: selection.zapBaseUrl });
  }
  return new FixtureZapEngine();
}

/** 選択に応じた探索 engine。fixture のときは FixtureExplorer (simulation)。 */
export function createExplorerEngine(selection: EngineSelection = resolveEngineSelection()): ExplorationPort {
  if (selection.explorer === 'playwright' && selection.explorerAllowedOrigins !== undefined) {
    return new PlaywrightExplorerAdapter({
      scope: { allowedOrigins: selection.explorerAllowedOrigins, deniedOrigins: [] },
    });
  }
  return new FixtureExplorer();
}

/** 能力表を作る。実 engine は source=measured、版は engine の申告値で固定。 */
export function createCapabilitySnapshots(input: {
  readonly zap: { readonly engineVersion: string; readonly real: boolean };
  readonly explorer: { readonly engineVersion: string; readonly real: boolean };
  readonly measuredAt: string;
}): readonly EngineCapabilitySnapshot[] {
  const enforced = {
    preSendScopeEnforcement: 'Enforced',
    stopControl: 'Enforced',
    budgetLease: 'Enforced',
    rateLimit: 'Enforced',
  } as const;
  const delegated = {
    preSendScopeEnforcement: 'Delegated',
    stopControl: 'Delegated',
    budgetLease: 'Delegated',
    rateLimit: 'Delegated',
  } as const;
  return [
    {
      engineKind: 'playwright',
      engineVersion: input.explorer.engineVersion,
      source: input.explorer.real ? 'measured' : 'fixture',
      guaranteeLevels: enforced,
      maxOvershootRatio: 0,
      measuredAt: input.measuredAt,
    },
    {
      engineKind: 'zap',
      engineVersion: input.zap.engineVersion,
      source: input.zap.real ? 'measured' : 'fixture',
      guaranteeLevels: delegated,
      maxOvershootRatio: 0.05,
      measuredAt: input.measuredAt,
    },
  ];
}

export interface ComposedEngines {
  readonly mode: 'fixture' | 'real';
  readonly explorer: ExplorationPort;
  readonly scanEngine: ActiveScanEnginePort;
  /** login 実行器 (design/f09)。実 engine 時のみ構成 (browser 駆動・遅延起動)。 */
  readonly loginExecutor?: LoginExecutorPort;
  /** Repeater 実 transport (design/f04)。実 engine 時のみ構成。 */
  readonly repeaterTransport?: import('@scopepilot2/core').RepeaterTransportPort;
  /** Fuzzer 実 transport (design/f05)。実 engine 時のみ構成。 */
  readonly fuzzTransport?: import('@scopepilot2/core').FuzzTransportPort;
  /** Sequencer 実 transport (design/f07)。実 engine 時のみ構成。 */
  readonly sequencerTransport?: import('@scopepilot2/core').SequencerTransportPort;
  /** self-host Interactsh provider (design/f13)。明示設定時のみ構成。 */
  readonly oastProvider?: import('@scopepilot2/core').OastProviderPort;
  /** WebSocket text 実 transport (design/f14)。実 engine 時のみ構成。 */
  readonly webSocketTransport?: import('@scopepilot2/core').WebSocketTransportPort;
  readonly capabilities: readonly EngineCapabilitySnapshot[];
  /** 実 engine 時の監査記録用 hash。fixture のときは呼出側の既定を使う。 */
  readonly runtimeBundleHash?: string;
  /** 実 playwright の後始末。fixture は何もしない。 */
  close(): Promise<void>;
}

/**
 * 環境変数から engine 群を組み立てる。実 ZAP 指定時は版を解決 (await) してから
 * 能力表を作る — runActiveScan は能力表の版と engine の版の一致を検証するため、
 * 未解決の版 (「zap-api (未確認)」) のまま能力表を作ると診断が始まらない。
 */
export async function composeEngines(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ComposedEngines> {
  const selection = resolveEngineSelection(env);
  const realZap = selection.mode === 'zap';
  const realExplorer = selection.explorer === 'playwright';
  const realOast = selection.oastServerUrl !== undefined && selection.interactshConfigPath !== undefined;
  if (!realZap && !realExplorer && !realOast) {
    return {
      mode: 'fixture',
      explorer: new FixtureExplorer(),
      scanEngine: new FixtureZapEngine(),
      capabilities: createCapabilitySnapshots({
        zap: { engineVersion: new FixtureZapEngine().engineVersion, real: false },
        explorer: { engineVersion: new FixtureExplorer().engineVersion, real: false },
        measuredAt: new Date(0).toISOString(),
      }),
      close: async () => {},
    };
  }
  const scanEngine: ActiveScanEnginePort =
    realZap && selection.zapBaseUrl !== undefined ? new ZapEngineAdapter({ baseUrl: selection.zapBaseUrl }) : new FixtureZapEngine();
  if (scanEngine instanceof ZapEngineAdapter) {
    await scanEngine.resolvedVersion();
  }
  const explorer = createExplorerEngine(selection);
  const playwrightAdapter = explorer instanceof PlaywrightExplorerAdapter ? explorer : null;
  // login 実行器は実 engine 構成で常に使えるようにする (browser は execute 時に遅延起動)。
  const loginExecutor = new PlaywrightLoginExecutor();
  // Repeater は ZAP 不要の直接送信のため、実 engine 構成では常に実 transport を使う。
  const repeaterTransport = new NodeRepeaterTransport();
  // Fuzzer も ZAP 不要の直接送信経路を使う。core が scope と 2 RPS を送信前に強制する。
  const fuzzTransport = new NodeFuzzTransport();
  const sequencerTransport = new NodeSequencerTransport();
  const webSocketTransport = new NodeWebSocketTransport();
  const interactshProvider = realOast
    ? new InteractshCliProvider({ serverUrl: selection.oastServerUrl!, configPath: selection.interactshConfigPath! })
    : undefined;
  // 一部だけ実 engine の構成でも、OAST 未設定を fixture 成功として見せない。
  const oastProvider: import('@scopepilot2/core').OastProviderPort = interactshProvider ?? {
    supportedProtocols: [],
    async startSession(): Promise<never> {
      throw new Error('OAST provider is not configured');
    },
  };
  return {
    mode: 'real',
    explorer,
    scanEngine,
    loginExecutor,
    repeaterTransport,
    fuzzTransport,
    sequencerTransport,
    webSocketTransport,
    oastProvider,
    capabilities: createCapabilitySnapshots({
      zap: { engineVersion: scanEngine.engineVersion, real: realZap },
      explorer: { engineVersion: explorer.engineVersion, real: realExplorer },
      measuredAt: new Date().toISOString(),
    }),
    ...(realExplorer ? { runtimeBundleHash: `real-engines:${scanEngine.engineVersion}` } : {}),
    close: async () => {
      if (playwrightAdapter !== null) {
        await playwrightAdapter.close();
      }
      await loginExecutor.close();
      await interactshProvider?.close();
    },
  };
}
