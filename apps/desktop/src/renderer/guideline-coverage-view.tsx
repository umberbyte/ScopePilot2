/**
 * ガイドラインカバレッジ表示コンポーネント
 *
 * GO-28: needs-input と汎用チェックの関係を利用者に見せる
 * 設計正本: docs/design/41-spec-gap-resolution.md §8.3
 *
 * Simple wizard (S05/S06/S07)、Advanced (A03)、report、CLI が共有する
 * 同じview modelからの表示。
 *
 * 現在は仮実装: GO-22 の GuidelineCoverageRoute 正本完成後、
 * 実際のカバレッジデータに接続する。
 */
import React, { useEffect, useState } from 'react';
import {
  makeStyles,
  MessageBar,
  MessageBarIntent,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableCellLayout,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  tokens,
  Badge,
  Caption1,
  Body1,
} from '@fluentui/react-components';
import { CheckmarkCircle20Regular, Circle20Regular, Warning20Regular, ErrorCircle20Regular, Question20Regular } from '@fluentui/react-icons';
import type { GuidelineCoverageSummaryView, GuidelineCoverageItemView, GuidelineCoverageResponse } from '@scopepilot2/contracts';

const useStyles = makeStyles({
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: '12px',
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
  summaryCard: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  summaryNumber: {
    fontSize: tokens.fontSizeHero700,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightHero700,
  },
  summaryLabel: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  table: {
    backgroundColor: tokens.colorNeutralBackground1,
  },
  statusIcon: {
    marginRight: '8px',
  },
  guaranteeBadge: {
    marginLeft: '8px',
  },
  muted: {
    color: tokens.colorNeutralForeground3,
  },
});

interface GuidelineCoverageViewProps {
  /** ガイドラインID（単一または複数のカンマ区切り） */
  readonly guidelineIds: readonly string[];

  /** API base URL */
  readonly apiBase: string;

  /** 実行結果を表示するか（trueの場合はrunIdが必要） */
  readonly showExecution?: boolean;

  /** run ID（実行結果表示時のみ） */
  readonly runId?: string;
}

async function fetchGuidelineCoverage(apiBase: string, guidelineId: string): Promise<GuidelineCoverageResponse> {
  const response = await fetch(`${apiBase}/api/guidelines/coverage?guidelineId=${encodeURIComponent(guidelineId)}`);
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as GuidelineCoverageResponse;
}

/**
 * ガイドラインカバレッジのサマリー表示
 */
export function GuidelineCoverageSummary(props: { readonly summary: GuidelineCoverageSummaryView }) {
  const styles = useStyles();
  const { summary } = props;

  return (
    <div className={styles.summaryGrid}>
      <div className={styles.summaryCard}>
        <div className={styles.summaryNumber}>{summary.totalItems}</div>
        <Caption1 className={styles.summaryLabel}>総項目数</Caption1>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryNumber} style={{ color: tokens.colorPaletteGreenForeground1 }}>
          {summary.automaticCount}
        </div>
        <Caption1 className={styles.summaryLabel}>自動実行予定</Caption1>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryNumber} style={{ color: tokens.colorPaletteBlueForeground1 }}>
          {summary.conditionalAutomaticCount}
        </div>
        <Caption1 className={styles.summaryLabel}>条件付き自動</Caption1>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryNumber} style={{ color: tokens.colorPaletteYellowForeground1 }}>
          {summary.needsInputCount}
        </div>
        <Caption1 className={styles.summaryLabel}>追加入力待ち</Caption1>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryNumber} style={{ color: tokens.colorNeutralForeground3 }}>
          {summary.unavailableCount}
        </div>
        <Caption1 className={styles.summaryLabel}>実行不可</Caption1>
      </div>
      <div className={styles.summaryCard}>
        <div className={styles.summaryNumber} style={{ color: tokens.colorNeutralForeground4 }}>
          {summary.notApplicableCount}
        </div>
        <Caption1 className={styles.summaryLabel}>対象外</Caption1>
      </div>
    </div>
  );
}

/**
 * ガイドラインカバレッジの項目詳細表
 */
export function GuidelineCoverageItemsTable(props: { readonly items: readonly GuidelineCoverageItemView[]; readonly showExecution?: boolean }) {
  const styles = useStyles();
  const { items, showExecution = false } = props;

  const getAutomationIcon = (automationClass: string) => {
    switch (automationClass) {
      case 'automatic':
        return <CheckmarkCircle20Regular className={styles.statusIcon} style={{ color: tokens.colorPaletteGreenForeground1 }} />;
      case 'conditional-automatic':
        return <Circle20Regular className={styles.statusIcon} style={{ color: tokens.colorPaletteBlueForeground1 }} />;
      case 'operator-workflow':
        return <Warning20Regular className={styles.statusIcon} style={{ color: tokens.colorPaletteYellowForeground1 }} />;
      case 'external-fixture':
      case 'unsupported':
        return <ErrorCircle20Regular className={styles.statusIcon} style={{ color: tokens.colorNeutralForeground3 }} />;
      default:
        return <Question20Regular className={styles.statusIcon} />;
    }
  };

  const getAutomationLabel = (automationClass: string) => {
    switch (automationClass) {
      case 'automatic':
        return '自動実行';
      case 'conditional-automatic':
        return '条件付き自動';
      case 'operator-workflow':
        return '要入力';
      case 'external-fixture':
        return '外部設備必要';
      case 'unsupported':
        return '未対応';
      default:
        return automationClass;
    }
  };

  const getGuaranteeBadge = (guarantee: string) => {
    switch (guarantee) {
      case 'Enforced':
        return (
          <Badge size="small" appearance="filled" color="success" className={styles.guaranteeBadge}>
            Enforced
          </Badge>
        );
      case 'Delegated':
        return (
          <Badge size="small" appearance="outline" color="warning" className={styles.guaranteeBadge}>
            Delegated
          </Badge>
        );
      case 'Unsupported':
        return (
          <Badge size="small" appearance="outline" className={styles.guaranteeBadge}>
            Unsupported
          </Badge>
        );
      default:
        return null;
    }
  };

  if (items.length === 0) {
    return (
      <MessageBar intent="info">
        ガイドラインが選択されていないか、該当する項目がありません。
      </MessageBar>
    );
  }

  return (
    <Table className={styles.table}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell>項目</TableHeaderCell>
          <TableHeaderCell>自動化クラス</TableHeaderCell>
          <TableHeaderCell>保証等級</TableHeaderCell>
          {showExecution && (
            <>
              <TableHeaderCell>実行状態</TableHeaderCell>
              <TableHeaderCell>判定</TableHeaderCell>
            </>
          )}
          <TableHeaderCell>不足入力</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((item) => {
          // 項目が複数routeを持つ場合、最初のrouteを代表として表示
          const primaryRoute = item.routes[0];
          if (primaryRoute === undefined) {
            return null;
          }

          return (
            <TableRow key={item.itemId}>
              <TableCell>
                <TableCellLayout>
                  <div>
                    <Body1>{item.itemDisplayName}</Body1>
                    <Caption1 className={styles.muted}>{item.checkItem}</Caption1>
                  </div>
                </TableCellLayout>
              </TableCell>
              <TableCell>
                <TableCellLayout>
                  <div style={{ display: 'flex', alignItems: 'center' }}>
                    {getAutomationIcon(primaryRoute.automationClass)}
                    <Text>{getAutomationLabel(primaryRoute.automationClass)}</Text>
                  </div>
                </TableCellLayout>
              </TableCell>
              <TableCell>
                <TableCellLayout>{getGuaranteeBadge(primaryRoute.guarantee)}</TableCellLayout>
              </TableCell>
              {showExecution && item.execution !== undefined && (
                <>
                  <TableCell>
                    <TableCellLayout>
                      <Text>{item.execution.executionStatus}</Text>
                    </TableCellLayout>
                  </TableCell>
                  <TableCell>
                    <TableCellLayout>
                      <Text>{item.execution.assessment}</Text>
                    </TableCellLayout>
                  </TableCell>
                </>
              )}
              {showExecution && item.execution === undefined && (
                <>
                  <TableCell>
                    <TableCellLayout>
                      <Text className={styles.muted}>未実行</Text>
                    </TableCellLayout>
                  </TableCell>
                  <TableCell>
                    <TableCellLayout>
                      <Text className={styles.muted}>—</Text>
                    </TableCellLayout>
                  </TableCell>
                </>
              )}
              <TableCell>
                <TableCellLayout>
                  {primaryRoute.missingInputs.length > 0 ? (
                    <div>
                      {primaryRoute.missingInputs.map((input, idx) => (
                        <Caption1 key={idx} className={styles.muted}>
                          {input.description}
                        </Caption1>
                      ))}
                    </div>
                  ) : (
                    <Text className={styles.muted}>—</Text>
                  )}
                </TableCellLayout>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * ガイドラインカバレッジの完全表示
 *
 * サマリーと項目詳細の両方を表示する。
 */
export function GuidelineCoverageView(props: GuidelineCoverageViewProps) {
  const styles = useStyles();
  const { guidelineIds, apiBase, showExecution = false, runId } = props;
  const [coverage, setCoverage] = useState<GuidelineCoverageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (guidelineIds.length === 0) {
      setCoverage(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    const guidelineId = guidelineIds.join(',');

    fetchGuidelineCoverage(apiBase, guidelineId)
      .then((data) => {
        setCoverage(data);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [guidelineIds, apiBase, showExecution, runId]);

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
        <Spinner label="カバレッジを読み込んでいます..." />
      </div>
    );
  }

  if (error !== null) {
    return (
      <MessageBar intent="error">
        カバレッジの取得に失敗しました: {error}
        <br />
        <Caption1 className={styles.muted}>
          ※ GO-28実装の初版: GO-22 GuidelineCoverageRoute 正本の完成後、実際のカバレッジデータに接続します。
        </Caption1>
      </MessageBar>
    );
  }

  if (coverage === null) {
    return (
      <MessageBar intent="info">
        ガイドラインを選択してください。
      </MessageBar>
    );
  }

  return (
    <div className={styles.container}>
      <div>
        <Body1>{coverage.summary.guidelineDisplayName}</Body1>
        <Caption1 className={styles.muted}>
          カタログ: {coverage.summary.catalog.version} (SHA: {coverage.summary.catalog.sha256.substring(0, 8)}...)
        </Caption1>
      </div>

      <GuidelineCoverageSummary summary={coverage.summary} />

      <div>
        <Body1>項目詳細</Body1>
        <Caption1 className={styles.muted}>
          実行状態と判定を分離して表示します。needs-input、unsupported、Delegated を明示します。
        </Caption1>
      </div>

      <GuidelineCoverageItemsTable items={coverage.items} showExecution={showExecution} />

      {!showExecution && (
        <MessageBar intent="info">
          <Caption1>
            ※ これは計画前の見込みです。実行後は「実行状態」と「判定」が別列で表示されます。
          </Caption1>
        </MessageBar>
      )}
    </div>
  );
}
