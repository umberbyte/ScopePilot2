/**
 * engine 構成の解決。fixture (simulation) と実 adapter の切替を環境変数で行う。
 * 秘密値 (ZAP API key) は環境変数のみで受け、argv・設定 file に置かない (F21-UT-007)。
 * 実行環境に ZAP が無ければ fixture のまま — 実 engine 指定は明示的な opt-in。
 */
import type { ActiveScanEnginePort } from '@scopepilot2/core';
import { FixtureZapEngine } from '@scopepilot2/simulation';
import { ZapEngineAdapter } from './zap-engine.ts';

export interface EngineSelection {
  readonly mode: 'fixture' | 'zap';
  readonly zapBaseUrl?: string;
}

/** 環境変数から engine 選択を解決する。SCOPEPILOT_ZAP_BASE_URL があるときのみ実 ZAP。 */
export function resolveEngineSelection(env: Readonly<Record<string, string | undefined>> = process.env): EngineSelection {
  const zapBaseUrl = env['SCOPEPILOT_ZAP_BASE_URL'];
  if (zapBaseUrl !== undefined && zapBaseUrl !== '') {
    return { mode: 'zap', zapBaseUrl };
  }
  return { mode: 'fixture' };
}

/** 選択に応じた能動診断 engine を組み立てる。fixture は simulation の固定実装。 */
export function createScanEngine(selection: EngineSelection = resolveEngineSelection()): ActiveScanEnginePort {
  if (selection.mode === 'zap' && selection.zapBaseUrl !== undefined) {
    return new ZapEngineAdapter({ baseUrl: selection.zapBaseUrl });
  }
  return new FixtureZapEngine();
}
