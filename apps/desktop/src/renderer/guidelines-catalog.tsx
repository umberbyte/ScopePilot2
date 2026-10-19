/**
 * A03 Guidelines & Check Catalog。`docs/design/27` の生成成果物
 * (docs/generated/guideline-catalog.json) を閲覧する画面コンポーネント。
 * catalog は docs 生成物を bundle に同梱して読み出す (API を介さない静的参照)。
 */
import React, { useState } from 'react';
import { Button, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, tokens } from '@fluentui/react-components';
import catalogJson from '../../../../docs/generated/guideline-catalog.json';

interface CatalogCheck {
  readonly no: string;
  readonly chapter: string;
  readonly itemId: string;
  readonly requirement: string;
  readonly checkItem: string;
  readonly method: string;
  readonly suspectedBehavior: string;
  readonly safeState: string;
}

interface CatalogRule {
  readonly no: string;
  readonly kind: string;
  readonly ruleId: string;
  readonly name: string;
  readonly target: string;
}

interface CatalogTheme {
  readonly no: string;
  readonly theme: string;
  readonly targetItems: string;
  readonly goal: string;
}

interface GuidelineCatalog {
  readonly schemaVersion: string;
  readonly catalogHash: string;
  readonly source: { readonly workbookPath: string; readonly sha256: string };
  readonly counts: { readonly guidelineChecks: number; readonly zapRules: number; readonly zapUnsupportedThemes: number };
  readonly guidelines: readonly { readonly sheet: string; readonly sourceNote: string; readonly checks: readonly CatalogCheck[] }[];
  readonly zapRules: readonly CatalogRule[];
  readonly zapUnsupportedThemes: readonly CatalogTheme[];
}

const CATALOG = catalogJson as unknown as GuidelineCatalog;

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  scroll: { maxHeight: '360px', overflowY: 'auto' },
});

export function GuidelinesCatalogScreen(): React.ReactElement {
  const styles = useStyles();
  const [tab, setTab] = useState<'checks' | 'rules' | 'themes'>('checks');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [selectedCheck, setSelectedCheck] = useState<CatalogCheck | null>(null);
  const guideline = CATALOG.guidelines[sheetIndex];

  const keyword = filter.trim().toLowerCase();
  const matches = (text: string): boolean => keyword === '' || text.toLowerCase().includes(keyword);
  const checks = (guideline?.checks ?? []).filter((check) => matches(check.checkItem) || matches(check.requirement) || matches(check.chapter));
  const rules = CATALOG.zapRules.filter((rule) => matches(rule.name) || matches(rule.target));
  const themes = CATALOG.zapUnsupportedThemes.filter((theme) => matches(theme.theme) || matches(theme.goal));

  return (
    <div className={styles.section}>
      <Text weight="semibold">Guidelines & Check Catalog</Text>
      <Text className={styles.muted}>
        {`catalog hash: ${CATALOG.catalogHash.slice(0, 16)}… / 元資料: ${CATALOG.source.workbookPath} (sha256 ${CATALOG.source.sha256.slice(0, 12)}…) / 診断項目 ${CATALOG.counts.guidelineChecks}・ZAP rule ${CATALOG.counts.zapRules}・ZAP 非対応 theme ${CATALOG.counts.zapUnsupportedThemes}`}
      </Text>
      <div className={styles.section}>
        {(['checks', 'rules', 'themes'] as const).map((candidate) => (
          <Button key={candidate} appearance={tab === candidate ? 'primary' : 'secondary'} onClick={() => setTab(candidate)}>
            {candidate === 'checks' ? 'ガイドライン診断項目' : candidate === 'rules' ? 'ZAP 診断ルール' : 'ZAP 非対応テーマ'}
          </Button>
        ))}
        <Input placeholder="絞り込み (項目名・要求・章)" value={filter} onChange={(_, data) => setFilter(data.value)} />
      </div>
      {tab === 'checks' && guideline !== undefined && (
        <>
          <div className={styles.section}>
            {CATALOG.guidelines.map((entry, index) => (
              <Button
                key={entry.sheet}
                appearance={index === sheetIndex ? 'primary' : 'secondary'}
                onClick={() => {
                  setSheetIndex(index);
                  setSelectedCheck(null);
                }}
              >
                {entry.sheet}
              </Button>
            ))}
          </div>
          <Text className={styles.muted}>{guideline.sourceNote}</Text>
          <Text>{`${guideline.sheet}: ${checks.length} 件 (全 ${guideline.checks.length} 件中)`}</Text>
          <div className={styles.scroll}>
            <Table size="small" aria-label="診断項目一覧">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>no</TableHeaderCell>
                  <TableHeaderCell>章 / item</TableHeaderCell>
                  <TableHeaderCell>診断項目</TableHeaderCell>
                  <TableHeaderCell>詳細</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.map((check) => (
                  <TableRow key={`${check.no}-${check.itemId}`}>
                    <TableCell>{check.no}</TableCell>
                    <TableCell>{`${check.chapter} (${check.itemId})`}</TableCell>
                    <TableCell>{check.checkItem}</TableCell>
                    <TableCell>
                      <Button size="small" onClick={() => setSelectedCheck(check)}>
                        開く
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {selectedCheck !== null && (
            <div className={styles.section}>
              <Text weight="semibold">{`項目 ${selectedCheck.no} ${selectedCheck.checkItem}`}</Text>
              <Text>{`要求: ${selectedCheck.requirement}`}</Text>
              <Text>{`検証方法: ${selectedCheck.method}`}</Text>
              <Text>{`疑わしい挙動: ${selectedCheck.suspectedBehavior}`}</Text>
              <Text>{`安全な状態: ${selectedCheck.safeState}`}</Text>
            </div>
          )}
        </>
      )}
      {tab === 'rules' && (
        <>
          <Text>{`ZAP 診断ルール: ${rules.length} 件 (全 ${CATALOG.zapRules.length} 件中)`}</Text>
          <div className={styles.scroll}>
            <Table size="small" aria-label="ZAP 診断ルール一覧">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>no</TableHeaderCell>
                  <TableHeaderCell>種別</TableHeaderCell>
                  <TableHeaderCell>ruleId</TableHeaderCell>
                  <TableHeaderCell>名前</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.no}>
                    <TableCell>{rule.no}</TableCell>
                    <TableCell>{rule.kind}</TableCell>
                    <TableCell>{rule.ruleId}</TableCell>
                    <TableCell>{rule.name}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
      {tab === 'themes' && (
        <>
          <Text>{`ZAP 非対応テーマ: ${themes.length} 件 (全 ${CATALOG.zapUnsupportedThemes.length} 件中)`}</Text>
          <div className={styles.scroll}>
            <Table size="small" aria-label="ZAP 非対応テーマ一覧">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>no</TableHeaderCell>
                  <TableHeaderCell>テーマ</TableHeaderCell>
                  <TableHeaderCell>対象項目</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {themes.map((theme) => (
                  <TableRow key={theme.no}>
                    <TableCell>{theme.no}</TableCell>
                    <TableCell>{theme.theme}</TableCell>
                    <TableCell>{theme.targetItems}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  );
}
