/**
 * A03 Guidelines & Check Catalog。`docs/design/27` の生成成果物
 * (docs/generated/guideline-catalog.json) を閲覧する画面コンポーネント。
 * catalog は docs 生成物を bundle に同梱して読み出す (API を介さない静的参照)。
 */
import React, { useState } from 'react';
import { Button, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';
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
        {t('a03.meta', { catalogHash: CATALOG.catalogHash.slice(0, 16), workbookPath: CATALOG.source.workbookPath, sha256: CATALOG.source.sha256.slice(0, 12), checks: CATALOG.counts.guidelineChecks, rules: CATALOG.counts.zapRules, themes: CATALOG.counts.zapUnsupportedThemes })}
      </Text>
      <div className={styles.section}>
        {(['checks', 'rules', 'themes'] as const).map((candidate) => (
          <Button key={candidate} appearance={tab === candidate ? 'primary' : 'secondary'} onClick={() => setTab(candidate)}>
            {candidate === 'checks' ? t('a03.tab.checks') : candidate === 'rules' ? t('a03.tab.rules') : t('a03.tab.themes')}
          </Button>
        ))}
        <Input placeholder={t('a03.filterPlaceholder')} value={filter} onChange={(_, data) => setFilter(data.value)} />
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
          <Text>{t('a03.checksCount', { sheet: guideline.sheet, shown: checks.length, total: guideline.checks.length })}</Text>
          <div className={styles.scroll}>
            <Table size="small" aria-label={t('a03.table.aria')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>no</TableHeaderCell>
                  <TableHeaderCell>{t('a03.col.chapter')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.col.checkItem')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.col.detail')}</TableHeaderCell>
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
                        {t('a03.open')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {selectedCheck !== null && (
            <div className={styles.section}>
              <Text weight="semibold">{t('a03.detailTitle', { no: selectedCheck.no, checkItem: selectedCheck.checkItem })}</Text>
              <Text>{t('a03.detail.requirement', { requirement: selectedCheck.requirement })}</Text>
              <Text>{t('a03.detail.method', { method: selectedCheck.method })}</Text>
              <Text>{t('a03.detail.suspected', { suspectedBehavior: selectedCheck.suspectedBehavior })}</Text>
              <Text>{t('a03.detail.safeState', { safeState: selectedCheck.safeState })}</Text>
            </div>
          )}
        </>
      )}
      {tab === 'rules' && (
        <>
          <Text>{t('a03.rulesCount', { shown: rules.length, total: CATALOG.zapRules.length })}</Text>
          <div className={styles.scroll}>
            <Table size="small" aria-label={t('a03.rulesTable.aria')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>no</TableHeaderCell>
                  <TableHeaderCell>{t('a03.col.kind')}</TableHeaderCell>
                  <TableHeaderCell>ruleId</TableHeaderCell>
                  <TableHeaderCell>{t('a03.col.name')}</TableHeaderCell>
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
          <Text>{t('a03.themesCount', { shown: themes.length, total: CATALOG.zapUnsupportedThemes.length })}</Text>
          <div className={styles.scroll}>
            <Table size="small" aria-label={t('a03.themesTable.aria')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>no</TableHeaderCell>
                  <TableHeaderCell>{t('a03.col.theme')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.col.targetItems')}</TableHeaderCell>
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
