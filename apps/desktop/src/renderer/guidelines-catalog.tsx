/**
 * A03 Guidelines & Check Catalog。`docs/design/27` の生成成果物
 * (docs/generated/guideline-catalog.json) を閲覧する画面コンポーネント。
 * catalog は docs 生成物を bundle に同梱して読み出す (API を介さない静的参照)。
 * ZAP 非対応テーマは閲覧だけでなく、承認済み代替検証をこの画面から実行する
 * (design/02 §3: ScopePilot 管理送信)。テーマ1 (認証回避・強制ブラウジング) は
 * POST /api/auth-bypass/checks で実行する。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Field, Input, Link, makeStyles, MessageBar, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t, type StringKey } from './resources.ts';
import { FIELD_LABEL_KEYS, IMPLEMENTED_THEME_NOS, missingRequiredInputs, partitionThemeFieldValues, THEME_SCHEMA, WORKFLOW_THEME_NOS } from './theme-schema.ts';
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
  readonly sourceUrl?: string;
  readonly coverageRoutes?: readonly string[];
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
  readonly zapStatus: string;
  readonly tools: string;
  readonly suspectedBehavior: string;
}

interface GuidelineCatalog {
  readonly schemaVersion: string;
  readonly catalogHash: string;
  readonly source: { readonly workbookPath: string; readonly sha256: string };
  readonly sources: readonly { readonly id: string; readonly version: string; readonly sourceUrl: string; readonly sha256: string; readonly itemCount: number }[];
  readonly counts: { readonly guidelineChecks: number; readonly zapRules: number; readonly zapUnsupportedThemes: number };
  readonly guidelines: readonly { readonly sheet: string; readonly sourceNote: string; readonly version: string; readonly sourceUrl: string; readonly linkOnly: boolean; readonly checks: readonly CatalogCheck[] }[];
  readonly zapRules: readonly CatalogRule[];
  readonly zapUnsupportedThemes: readonly CatalogTheme[];
}

const CATALOG = catalogJson as unknown as GuidelineCatalog;

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
  scroll: { maxHeight: '360px', overflowY: 'auto' },
  inline: { display: 'flex', flexDirection: 'column', gap: '8px', maxWidth: '640px' },
});

async function callJson<T>(apiBase: string, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(errorBody?.message ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

interface SessionView {
  readonly role: string;
  readonly flowVersion: string;
  readonly stepCount: number;
  readonly secretReferences: readonly string[];
  readonly cookieNames: readonly string[];
  readonly sessionRevision: number;
  readonly verificationUrl: string | null;
}

interface ProbeView {
  readonly kind: 'page' | 'login';
  readonly pattern: string;
  readonly targetUrl: string;
  readonly status: number | null;
  readonly finalUrl: string;
  readonly bodyHash: string;
  readonly outcome: string | null;
  readonly markersFound: boolean | null;
}

interface CheckSummaryView {
  readonly checkId: string;
  readonly themeNo: string;
  readonly role: string;
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly totalRequests: number;
  readonly loginVariantsNotRun: readonly string[];
  readonly executedAt: string;
  readonly results: readonly ProbeView[];
}

interface CheckListItemView {
  readonly checkId: string;
  readonly themeNo: string;
  readonly role: string;
  readonly status: string;
  readonly totalRequests: number;
  readonly loginVariantsNotRun: readonly string[];
  readonly executedAt: string;
}

function outcomeLabel(outcome: string | null): string {
  if (outcome === 'exposed') {
    return t('a03.theme1.outcome.exposed');
  }
  if (outcome === 'denied') {
    return t('a03.theme1.outcome.denied');
  }
  if (outcome === 'inconclusive') {
    return t('a03.theme1.outcome.inconclusive');
  }
  return '—';
}

/** テーマ1「認証回避・強制ブラウジング」の代替検証実行パネル。 */
function AuthBypassRunner({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [sessions, setSessions] = useState<readonly SessionView[]>([]);
  const [role, setRole] = useState('');
  const [targets, setTargets] = useState('');
  const [cookieNames, setCookieNames] = useState('');
  const [includeLoginVariants, setIncludeLoginVariants] = useState(false);
  const [secretInputs, setSecretInputs] = useState<Readonly<Record<string, string>>>({});
  const [summary, setSummary] = useState<CheckSummaryView | null>(null);
  const [history, setHistory] = useState<readonly CheckListItemView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const sessionBody = await callJson<{ sessions: readonly SessionView[] }>(apiBase, 'GET', '/api/sessions');
    setSessions(sessionBody.sessions);
    const selected = sessionBody.sessions.find((candidate) => candidate.role === role) ?? sessionBody.sessions[0];
    if (selected !== undefined && role === '') {
      setRole(selected.role);
      setTargets(selected.verificationUrl ?? '');
    }
    const historyBody = await callJson<{ checks: readonly CheckListItemView[] }>(apiBase, 'GET', '/api/auth-bypass/checks');
    setHistory(historyBody.checks);
  }, [apiBase, role]);

  useEffect(() => {
    void load().catch((cause: unknown) => setError(String(cause)));
  }, [load]);

  const selectedSession = sessions.find((candidate) => candidate.role === role);

  const run = useCallback(async () => {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      const targetUrls = targets.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const result = await callJson<CheckSummaryView>(apiBase, 'POST', '/api/auth-bypass/checks', {
        role,
        ...(targetUrls.length === 0 ? {} : { targetUrls }),
        ...(cookieNames.trim() === '' ? {} : { authCookieNames: cookieNames.split(',').map((name) => name.trim()).filter((name) => name !== '') }),
        includeLoginVariants,
        ...(includeLoginVariants && Object.keys(secretInputs).length > 0 ? { secretValues: secretInputs } : {}),
      });
      setSummary(result);
      await load();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, cookieNames, includeLoginVariants, load, role, secretInputs, targets]);

  if (sessions.length === 0) {
    return <MessageBar>{t('a03.theme1.noSessions')}</MessageBar>;
  }

  return (
    <div className={styles.section}>
      <Text weight="semibold">{t('a03.theme1.title')}</Text>
      <div className={styles.inline}>
        <Field label={t('a03.theme1.role')}>
          <select value={role} onChange={(event) => {
            setRole(event.target.value);
            const next = sessions.find((candidate) => candidate.role === event.target.value);
            setCookieNames('');
            setTargets(next?.verificationUrl ?? '');
          }}>
            {sessions.map((candidate) => (
              <option key={candidate.role} value={candidate.role}>{candidate.role}</option>
            ))}
          </select>
        </Field>
        <Field label={t('a03.theme1.targets')}>
          <Textarea value={targets} onChange={(_, data) => setTargets(data.value)} rows={3} />
        </Field>
        <Field label={t('a03.theme1.cookies')}>
          <Input value={cookieNames} onChange={(_, data) => setCookieNames(data.value)} />
        </Field>
        <Checkbox
          label={t('a03.theme1.loginVariants')}
          checked={includeLoginVariants}
          onChange={(_, data) => setIncludeLoginVariants(data.checked === true)}
        />
        {includeLoginVariants && (selectedSession?.secretReferences ?? []).map((reference) => (
          <Field key={reference} label={t('a03.theme1.secret', { ref: reference })}>
            <Input type="password" value={secretInputs[reference] ?? ''} onChange={(_, data) => setSecretInputs((current) => ({ ...current, [reference]: data.value }))} />
          </Field>
        ))}
        <div>
          <Button appearance="primary" disabled={busy || role === '' || cookieNames.trim() === ''} onClick={() => void run()}>{t('a03.theme1.run')}</Button>
        </div>
      </div>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      {summary !== null && (
        <div className={styles.section}>
          <Text weight="semibold">{`${summary.checkId} — ${summary.status} (${t('a03.theme1.totalRequests', { count: summary.totalRequests })})`}</Text>
          {summary.loginVariantsNotRun.length > 0 && (
            <Text className={styles.muted}>{t('a03.theme1.notRun', { patterns: summary.loginVariantsNotRun.join(', ') })}</Text>
          )}
          <div className={styles.scroll}>
            <Table size="small" aria-label={t('a03.themesTable.aria')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('a03.theme1.col.pattern')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.theme1.col.target')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.theme1.col.status')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.theme1.col.outcome')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.results.map((probe, index) => (
                  <TableRow key={`${probe.pattern}-${index}`}>
                    <TableCell>{`${probe.kind}:${probe.pattern}`}</TableCell>
                    <TableCell>{probe.kind === 'page' && probe.finalUrl !== probe.targetUrl ? `${probe.targetUrl} → ${probe.finalUrl}` : probe.targetUrl}</TableCell>
                    <TableCell>{probe.status === null ? '—' : probe.status}</TableCell>
                    <TableCell>{outcomeLabel(probe.outcome)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <Text weight="semibold">{t('a03.theme1.history')}</Text>
      {history.length === 0 ? (
        <Text className={styles.muted}>—</Text>
      ) : (
        history.map((item) => (
          <Text key={item.checkId} block>
            {`${item.executedAt} ${item.checkId} role=${item.role} status=${item.status} requests=${item.totalRequests}`}
          </Text>
        ))
      )}
    </div>
  );
}

/** テーマ2以降の入力 schema は theme-schema.ts (Core 側実装テーマ一覧と test で同期)。 */

interface ThemeSummaryView {
  readonly checkId: string;
  readonly themeNo: string;
  readonly role: string | null;
  readonly status: 'pass' | 'fail' | 'inconclusive';
  readonly totalRequests: number;
  readonly skipped?: readonly string[];
  readonly executedAt: string;
  readonly results: readonly { readonly kind: string; readonly pattern: string; readonly targetUrl: string; readonly status: number | null; readonly finalUrl: string; readonly bodyHash: string; readonly outcome: string | null; readonly detail?: string }[];
}

/** テーマ2以降の汎用代替検証ランナー (POST /api/zap-unsupported/checks)。 */
function ThemeRunner({ apiBase, themeNo }: { apiBase: string; themeNo: string }): React.ReactElement | null {
  const schema = THEME_SCHEMA[themeNo];
  const styles = useStyles();
  const [sessions, setSessions] = useState<readonly SessionView[]>([]);
  const [role, setRole] = useState('');
  const [targets, setTargets] = useState('');
  const [namedTargetValues, setNamedTargetValues] = useState<Readonly<Record<string, string>>>({});
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [secretsText, setSecretsText] = useState('');
  const [summary, setSummary] = useState<ThemeSummaryView | null>(null);
  const [history, setHistory] = useState<readonly { checkId: string; themeNo: string; role: string | null; status: string; totalRequests: number; executedAt: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** select 欄は未選択状態を持たず、常に先頭候補 (Core 既定値) を表示する。 */
  const selectValue = (field: { readonly key: string; readonly options?: readonly string[] }): string => values[field.key] ?? field.options?.[0] ?? '';

  useEffect(() => {
    void (async () => {
      try {
        const sessionBody = await callJson<{ sessions: readonly SessionView[] }>(apiBase, 'GET', '/api/sessions');
        setSessions(sessionBody.sessions);
        if (sessionBody.sessions[0] !== undefined) {
          setRole(sessionBody.sessions[0].role);
        }
        const historyBody = await callJson<{ checks: { checkId: string; themeNo: string; role: string | null; status: string; totalRequests: number; executedAt: string }[] }>(apiBase, 'GET', '/api/zap-unsupported/checks');
        setHistory(historyBody.checks.filter((item) => item.themeNo === themeNo));
      } catch (cause) {
        setError(String(cause));
      }
    })();
  }, [apiBase, themeNo]);

  const run = useCallback(async () => {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      if (schema === undefined) return;
      const partitioned = partitionThemeFieldValues(schema, values);
      const params = { ...partitioned.params };
      const secretValues = { ...partitioned.secretValues };
      for (const line of secretsText.split('\n')) {
        const separator = line.indexOf('=');
        if (separator > 0) {
          secretValues[line.slice(0, separator).trim()] = line.slice(separator + 1);
        }
      }
      const targetUrls = (schema?.namedTargets ?? []).length > 0
        ? (schema?.namedTargets ?? []).flatMap((target) => {
          const url = (namedTargetValues[target.key] ?? '').trim();
          return url === '' ? [] : [url];
        })
        : targets.split('\n').map((line) => line.trim()).filter((line) => line !== '');
      const result = await callJson<ThemeSummaryView>(apiBase, 'POST', '/api/zap-unsupported/checks', {
        themeNo,
        ...(role === '' || schema?.roleMode === 'none' ? {} : { role }),
        ...(schema?.needsTargets === true ? { targetUrls } : {}),
        ...(Object.keys(params).length === 0 ? {} : { params }),
        ...(Object.keys(secretValues).length === 0 ? {} : { secretValues }),
      });
      setSummary(result);
      const historyBody = await callJson<{ checks: { checkId: string; themeNo: string; role: string | null; status: string; totalRequests: number; executedAt: string }[] }>(apiBase, 'GET', '/api/zap-unsupported/checks');
      setHistory(historyBody.checks.filter((item) => item.themeNo === themeNo));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, namedTargetValues, role, schema, secretsText, selectValue, targets, themeNo, values]);

  if (schema === undefined) {
    return null;
  }
  const missing = missingRequiredInputs(themeNo, schema, values, namedTargetValues);

  return (
    <div className={styles.section}>
      <div className={styles.inline}>
        {schema.roleMode !== 'none' && sessions.length > 0 && (
          <Field label={t('a03.theme1.role')}>
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              {schema.roleMode === 'optional' && <option value="">(none)</option>}
              {sessions.map((candidate) => (
                <option key={candidate.role} value={candidate.role}>{candidate.role}</option>
              ))}
            </select>
          </Field>
        )}
        {(schema.namedTargets ?? []).map((target) => (
          <Field key={target.key} label={t(target.labelKey)}>
            <Input value={namedTargetValues[target.key] ?? ''} onChange={(_, data) => setNamedTargetValues((current) => ({ ...current, [target.key]: data.value }))} />
          </Field>
        ))}
        {schema.needsTargets && (schema.namedTargets ?? []).length === 0 && (
          <Field label={t('a03.theme1.targets')}>
            <Textarea value={targets} onChange={(_, data) => setTargets(data.value)} rows={3} />
          </Field>
        )}
        {schema.fields.map((field) => {
          const labelKey = FIELD_LABEL_KEYS[`${themeNo}.${field.key}`] ?? 'a03.theme1.col.pattern';
          if (field.kind === 'boolean') {
            return (
              <Checkbox
                key={field.key}
                label={t(labelKey)}
                checked={values[field.key] === 'true'}
                onChange={(_, data) => setValues((current) => ({ ...current, [field.key]: data.checked === true ? 'true' : '' }))}
              />
            );
          }
          if (field.kind === 'select') {
            return (
              <Field key={field.key} label={t(labelKey)}>
                <select value={selectValue(field)} onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}>
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </Field>
            );
          }
          return (
            <Field key={field.key} label={t(labelKey)}>
              {field.multiline === true
                ? <Textarea rows={4} value={values[field.key] ?? ''} onChange={(_, data) => setValues((current) => ({ ...current, [field.key]: data.value }))} />
                : <Input type={field.secret === true ? 'password' : 'text'} value={values[field.key] ?? ''} onChange={(_, data) => setValues((current) => ({ ...current, [field.key]: data.value }))} />}
            </Field>
          );
        })}
        <Field label={t('a03.theme.secretsHint')}>
          <Textarea rows={2} value={secretsText} onChange={(_, data) => setSecretsText(data.value)} />
        </Field>
        <div>
          <Button appearance="primary" disabled={busy || missing.length > 0} onClick={() => void run()}>{t('a03.theme.run')}</Button>
          {missing.length > 0 && <Text className={styles.muted}>{t('a03.theme.missingRequired', { labels: missing.map((key) => t(key)).join(', ') })}</Text>}
        </div>
      </div>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      {summary !== null && (
        <div className={styles.section}>
          <Text weight="semibold">{`${summary.checkId} — ${summary.status} (${t('a03.theme1.totalRequests', { count: summary.totalRequests })})`}</Text>
          {(summary.skipped ?? []).length > 0 && (
            <Text className={styles.muted}>{t('a03.theme.skipped', { notes: (summary.skipped ?? []).join(' / ') })}</Text>
          )}
          <div className={styles.scroll}>
            <Table size="small" aria-label={t('a03.themesTable.aria')}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>{t('a03.theme1.col.pattern')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.theme1.col.target')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.theme1.col.status')}</TableHeaderCell>
                  <TableHeaderCell>{t('a03.theme1.col.outcome')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {summary.results.map((probe, index) => (
                  <TableRow key={`${probe.pattern}-${index}`}>
                    <TableCell>{`${probe.kind}:${probe.pattern}`}</TableCell>
                    <TableCell>{probe.targetUrl === '' ? '—' : probe.finalUrl === '' || probe.finalUrl === probe.targetUrl ? probe.targetUrl : `${probe.targetUrl} → ${probe.finalUrl}`}</TableCell>
                    <TableCell>{probe.status === null ? '—' : probe.status}</TableCell>
                    <TableCell>{probe.detail === undefined ? outcomeLabel(probe.outcome) : `${outcomeLabel(probe.outcome)} (${probe.detail})`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
      <Text weight="semibold">{t('a03.theme1.history')}</Text>
      {history.length === 0 ? (
        <Text className={styles.muted}>—</Text>
      ) : (
        history.map((item) => (
          <Text key={item.checkId} block>{`${item.executedAt} ${item.checkId} role=${item.role ?? '—'} status=${item.status} requests=${String(item.totalRequests)}`}</Text>
        ))
      )}
    </div>
  );
}

export function GuidelinesCatalogScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [tab, setTab] = useState<'checks' | 'rules' | 'themes'>('checks');
  const [sheetIndex, setSheetIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [selectedCheck, setSelectedCheck] = useState<CatalogCheck | null>(null);
  const [activeTheme, setActiveTheme] = useState<string | null>(null);
  const guideline = CATALOG.guidelines[sheetIndex];

  const keyword = filter.trim().toLowerCase();
  const matches = (text: string): boolean => keyword === '' || text.toLowerCase().includes(keyword);
  const checks = (guideline?.checks ?? []).filter((check) => matches(check.checkItem) || matches(check.requirement) || matches(check.chapter));
  const rules = CATALOG.zapRules.filter((rule) => matches(rule.name) || matches(rule.target));
  const themes = CATALOG.zapUnsupportedThemes.filter((theme) => matches(theme.theme) || matches(theme.goal));
  const activeThemeDetail = CATALOG.zapUnsupportedThemes.find((theme) => theme.no === activeTheme);

  return (
    <div className={styles.section}>
      <Text weight="semibold">Guidelines & Check Catalog</Text>
      <Text className={styles.muted}>
        {t('a03.meta', { catalogHash: CATALOG.catalogHash.slice(0, 16), workbookPath: CATALOG.source.workbookPath, sha256: CATALOG.source.sha256.slice(0, 12), checks: CATALOG.counts.guidelineChecks, rules: CATALOG.counts.zapRules, themes: CATALOG.counts.zapUnsupportedThemes })}
      </Text>
      <Text className={styles.muted}>{t('a03.sources', { count: CATALOG.sources.length })}</Text>
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
          {guideline.sourceUrl !== '' && (
            <Link href={guideline.sourceUrl} target="_blank" rel="noreferrer">{t('a03.openOfficialSource', { version: guideline.version })}</Link>
          )}
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
              {(selectedCheck.coverageRoutes ?? []).length > 0 && (
                <Text>{t('a03.detail.coverageRoutes', { routes: (selectedCheck.coverageRoutes ?? []).join(', ') })}</Text>
              )}
              {selectedCheck.sourceUrl !== undefined && (
                <Link href={selectedCheck.sourceUrl} target="_blank" rel="noreferrer">{t('a03.detail.officialSource')}</Link>
              )}
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
                  <TableHeaderCell>{t('common.col.actions')}</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {themes.map((theme) => (
                  <TableRow key={theme.no}>
                    <TableCell>{theme.no}</TableCell>
                    <TableCell>{theme.theme}</TableCell>
                    <TableCell>{theme.targetItems}</TableCell>
                    <TableCell>
                      {IMPLEMENTED_THEME_NOS.includes(theme.no) && (
                        <Button size="small" appearance={activeTheme === theme.no ? 'primary' : 'secondary'} onClick={() => setActiveTheme((current) => current === theme.no ? null : theme.no)}>
                          {t('a03.theme.run')}
                        </Button>
                      )}
                      {WORKFLOW_THEME_NOS.includes(theme.no) && <Text size={200}>{t('a03.theme.workflowAutomatic')}</Text>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {activeThemeDetail !== undefined && (
            <div className={styles.section}>
              <Text weight="semibold">{`${activeThemeDetail.no} ${activeThemeDetail.theme}`}</Text>
              <Text>{activeThemeDetail.goal}</Text>
              <Text className={styles.muted}>{activeThemeDetail.zapStatus}</Text>
              <Text>{t('a03.theme.tools', { tools: activeThemeDetail.tools })}</Text>
              <Text>{t('a03.theme.suspected', { behavior: activeThemeDetail.suspectedBehavior })}</Text>
            </div>
          )}
          {activeTheme === '1' && <AuthBypassRunner apiBase={apiBase} />}
          {activeTheme !== null && activeTheme !== '1' && <ThemeRunner apiBase={apiBase} themeNo={activeTheme} />}
        </>
      )}
    </div>
  );
}
