/**
 * 機能画面の共通レイアウト (FeaturePage)。`docs/design/40-advanced-mode-redesign.md` §4.1。
 * すべての Advanced 画面は共通コンポーネント FeaturePage で組み立てる。
 * 送信を伴う画面は「入力 → 実行 → 進捗 → 結果」、送信を伴わない画面は「入力 → 結果」の
 * 部分集合を使う。
 */
import React from 'react';
import {
  makeStyles,
  Text,
  Button,
  Divider,
  tokens,
  Badge,
  MessageBar,
  MessageBarBody,
  Spinner,
} from '@fluentui/react-components';
import { Info20Regular, Send20Regular, Shield20Regular, ArrowSync20Regular } from '@fluentui/react-icons';
import type { FeatureSpec, GuaranteeLevel } from './feature-spec.ts';

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  headerTop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  breadcrumb: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  title: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
  },
  purpose: {
    color: tokens.colorNeutralForeground2,
    fontSize: tokens.fontSizeBase300,
  },
  badges: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  content: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  inputPanel: {
    width: '40%',
    minWidth: '320px',
    maxWidth: '600px',
    padding: tokens.spacingVerticalL,
    borderRight: `1px solid ${tokens.colorNeutralStroke1}`,
    overflowY: 'auto',
  },
  inputSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
  },
  estimateBox: {
    marginTop: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalS,
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  actionButtons: {
    display: 'flex',
    gap: tokens.spacingHorizontalS,
    marginTop: tokens.spacingVerticalL,
  },
  resultsPanel: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  progressSection: {
    padding: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke1}`,
  },
  resultsContent: {
    flex: 1,
    padding: tokens.spacingVerticalL,
    overflowY: 'auto',
  },
  activityPanel: {
    borderTop: `1px solid ${tokens.colorNeutralStroke1}`,
    backgroundColor: tokens.colorNeutralBackground3,
    padding: tokens.spacingVerticalS,
    minHeight: '120px',
    maxHeight: '300px',
  },
});

/** 保証等級のアイコンとラベル。 */
function GuaranteeBadge({ level }: { level: GuaranteeLevel }): React.ReactElement {
  const icon = level === 'Enforced' ? <Shield20Regular /> : <ArrowSync20Regular />;
  const color = level === 'Enforced' ? 'success' : 'warning';
  const label = level === 'Enforced' ? 'Enforced (送信前判定)' : level === 'Delegated' ? 'Delegated (推定)' : 'Mixed';

  return (
    <Badge appearance="tint" color={color} icon={icon}>
      {label}
    </Badge>
  );
}

/** FeaturePage のプロパティ。 */
export interface FeaturePageProps {
  /** 画面の定義。 */
  readonly spec: FeatureSpec;
  /** グループ名 (パンくず表示用)。 */
  readonly groupLabel?: string;
  /** 画面タイトル (spec.titleKey から解決された文字列)。 */
  readonly title: string;
  /** 画面の目的 (spec.purposeKey から解決された文字列)。 */
  readonly purpose: string;
  /** ヘルプボタンのクリックハンドラ。 */
  readonly onHelp?: () => void;
  /** 入力領域の内容 (子コンポーネント)。 */
  readonly inputContent?: React.ReactNode;
  /** 推定情報 (送信機能の場合)。 */
  readonly estimate?: {
    readonly maxRequests?: number;
    readonly maxPages?: number;
    readonly duration?: string;
    readonly budgetRemaining?: number;
  };
  /** 推定中かどうか。 */
  readonly estimating?: boolean;
  /** 実行ボタンのラベル。 */
  readonly executeLabel?: string;
  /** 実行ボタンのクリックハンドラ。 */
  readonly onExecute?: () => void;
  /** 実行ボタンが無効かどうか。 */
  readonly executeDisabled?: boolean;
  /** 進捗情報 (実行中の場合)。 */
  readonly progress?: {
    readonly state: 'queued' | 'running' | 'stopping' | 'completed' | 'stopped' | 'failed';
    readonly percentage?: number;
    readonly statusText: string;
    readonly elapsed?: string;
  };
  /** 停止ボタンのクリックハンドラ。 */
  readonly onStop?: () => void;
  /** 結果領域の内容 (子コンポーネント)。 */
  readonly resultsContent?: React.ReactNode;
  /** エラーメッセージ。 */
  readonly error?: string;
}

/**
 * 機能画面の共通レイアウト。
 * 設計 40 §4.1 の構成に従い、見出し・入力・実行・進捗・結果・アクティビティパネルを統一する。
 */
export function FeaturePage(props: FeaturePageProps): React.ReactElement {
  const styles = useStyles();
  const {
    spec,
    groupLabel,
    title,
    purpose,
    onHelp,
    inputContent,
    estimate,
    estimating,
    executeLabel,
    onExecute,
    executeDisabled,
    progress,
    onStop,
    resultsContent,
    error,
  } = props;

  return (
    <div className={styles.container}>
      {/* ヘッダー */}
      <div className={styles.header}>
        <div className={styles.headerTop}>
          <div>
            {/* パンくず */}
            {groupLabel && (
              <div className={styles.breadcrumb}>
                <Text>{groupLabel}</Text>
                <Text>›</Text>
                <Text>{title}</Text>
              </div>
            )}
            {/* タイトルと badges */}
            <div className={styles.titleRow}>
              <Text className={styles.title}>{title}</Text>
              <div className={styles.badges}>
                {spec.sendsTraffic && (
                  <Badge appearance="outline" icon={<Send20Regular />}>
                    ⇅ 送信あり
                  </Badge>
                )}
                {spec.guarantee && <GuaranteeBadge level={spec.guarantee} />}
              </div>
            </div>
          </div>
          {/* ヘルプボタン */}
          {onHelp && (
            <Button appearance="subtle" icon={<Info20Regular />} onClick={onHelp}>
              使い方
            </Button>
          )}
        </div>
        {/* 目的 */}
        <Text className={styles.purpose}>{purpose}</Text>
      </div>

      {/* エラー表示 */}
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}

      {/* コンテンツ */}
      <div className={styles.content}>
        {/* 入力パネル */}
        {inputContent && (
          <div className={styles.inputPanel}>
            <div className={styles.inputSection}>
              {inputContent}

              {/* 推定 */}
              {spec.sendsTraffic && (
                <div className={styles.estimateBox}>
                  {estimating ? (
                    <Spinner size="tiny" label="推定中..." />
                  ) : estimate ? (
                    <>
                      <Text weight="semibold">推定:</Text>
                      {estimate.maxRequests !== undefined && <Text> 最大 {estimate.maxRequests} 要求</Text>}
                      {estimate.maxPages !== undefined && <Text> / {estimate.maxPages} ページ</Text>}
                      {estimate.duration && <Text> / {estimate.duration}</Text>}
                      {estimate.budgetRemaining !== undefined && (
                        <Text> (案件残 {estimate.budgetRemaining})</Text>
                      )}
                    </>
                  ) : null}
                </div>
              )}

              {/* 実行ボタン */}
              {onExecute && (
                <div className={styles.actionButtons}>
                  <Button appearance="primary" disabled={executeDisabled ?? false} onClick={onExecute}>
                    {executeLabel ?? '実行'}
                  </Button>
                  <Button appearance="secondary">既定に戻す</Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* 結果パネル */}
        <div className={styles.resultsPanel}>
          {/* 進捗 */}
          {progress && (
            <div className={styles.progressSection}>
              <Text weight="semibold">
                状態: {progress.statusText}
                {progress.elapsed && ` (${progress.elapsed})`}
              </Text>
              {progress.state === 'running' && progress.percentage !== undefined && (
                <Text> {progress.percentage}%</Text>
              )}
              {onStop && progress.state === 'running' && (
                <Button appearance="secondary" size="small" onClick={onStop}>
                  ■ 停止
                </Button>
              )}
            </div>
          )}

          {/* 結果 */}
          <div className={styles.resultsContent}>{resultsContent}</div>
        </div>
      </div>

      {/* アクティビティパネル (placeholder) */}
      <div className={styles.activityPanel}>
        <Text size={200} weight="semibold">
          ▾ アクティビティ
        </Text>
        <Text size={200}>(ログ・送信・拒否・エラーのタブ — 実装は §5.4)</Text>
      </div>
    </div>
  );
}
