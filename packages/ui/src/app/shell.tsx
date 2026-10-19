/**
 * 共通 shell (Fluent UI v9)。`docs/detailed-design/02-ui-information-architecture.md` §0・§1。
 * 上部に案件・モード・認可・実行状態を示し、色以外の文言も持たせる規則は token だけで満たさない。
 * 描画の検証は Playwright app test で行い、ここは構成のみを置く。
 */
import { FluentProvider, webDarkTheme, webLightTheme, Tooltip, Badge, Text, tokens } from '@fluentui/react-components';

export interface ShellStatus {
  readonly caseName: string;
  readonly mode: 'simple' | 'advanced';
  readonly authorization: 'valid' | 'expired' | 'missing';
  readonly runState: string;
  readonly inScope: boolean;
}

function authorizationLabel(status: ShellStatus['authorization']): string {
  switch (status) {
    case 'valid':
      return '認可: 有効';
    case 'expired':
      return '認可: 期限切れ (送信不可)';
    case 'missing':
      return '認可: 未設定';
  }
}

export function shellAriaSummary(status: ShellStatus): string {
  const scopeLabel = status.inScope ? '対象内' : '範囲外あり';
  return `${status.caseName} / モード ${status.mode === 'simple' ? 'シンプル' : 'アドバンスド'} / ${authorizationLabel(status.authorization)} / 実行 ${status.runState} / ${scopeLabel}`;
}

export const ShellTokens = { tokens, FluentProvider, webLightTheme, webDarkTheme, Tooltip, Badge, Text };
