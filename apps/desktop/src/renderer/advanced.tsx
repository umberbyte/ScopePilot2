/**
 * Advanced モード画面。`docs/detailed-design/02-ui-information-architecture.md` §3。
 * A01〜A13 のナビは packages/ui の advancedNavItems (権限で隠す規則は mode-policy と同一)。
 * まず読取系の A01 Dashboard / Case と A12 Jobs / Evidence / Audit を実装し、
 * 他画面は「未実装」プレースホルダで明示する (空画面にしない)。
 * 編集系 (crawl 計画・テンプレート選択など) は後続増分で、API は読取 endpoint のみ使う。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, tokens } from '@fluentui/react-components';
import { advancedDefaultRoute, advancedNavItems, type AdvancedNavItem } from '@scopepilot2/ui';
import type { CaseRecord, EngineCapabilitySnapshot, OperatorPermission, RunRecord } from '@scopepilot2/contracts';

/** desktop harness の operator (fixture・全権限)。operator 照会 API は後続増分で追加する。 */
const OPERATOR_PERMISSIONS: readonly OperatorPermission[] = ['case.manage', 'case.read', 'run.manage', 'finding.confirm', 'report.export'];

const CONTROL_ASPECTS = ['preSendScopeEnforcement', 'stopControl', 'budgetLease', 'rateLimit'] as const;

interface AuditEvent {
  readonly eventId: number;
  readonly type: string;
  readonly at: string;
}

const useStyles = makeStyles({
  root: { display: 'flex', gap: '16px', padding: '16px', alignItems: 'flex-start' },
  nav: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: '300px' },
  navItem: { textAlign: 'left', padding: '6px 10px', borderRadius: '4px', border: 'none', background: 'transparent', cursor: 'pointer' },
  navActive: { fontWeight: 600, backgroundColor: tokens.colorBrandBackground2 },
  content: { display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minWidth: '560px' },
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
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

async function callNdjson<T>(apiBase: string, path: string): Promise<readonly T[]> {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const text = await response.text();
  return text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as T);
}

export function AdvancedApp({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [items] = useState<readonly AdvancedNavItem[]>(() => advancedNavItems(OPERATOR_PERMISSIONS));
  const [activeRoute, setActiveRoute] = useState<string>(() => advancedDefaultRoute(OPERATOR_PERMISSIONS) ?? 'advanced.dashboard');
  const [caseRecord, setCaseRecord] = useState<CaseRecord | null>(null);
  const [caseMissing, setCaseMissing] = useState(false);
  const [capabilities, setCapabilities] = useState<readonly EngineCapabilitySnapshot[]>([]);
  const [interrupted, setInterrupted] = useState<readonly RunRecord[]>([]);
  const [events, setEvents] = useState<readonly AuditEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refreshCase = useCallback(async () => {
    try {
      const record = await callJson<CaseRecord>(apiBase, 'GET', '/api/case');
      setCaseRecord(record);
      setCaseMissing(false);
    } catch {
      // GET /api/case は案件未作成で ValidationFailed を返す。「未作成」扱いにするだけに留める。
      setCaseRecord(null);
      setCaseMissing(true);
    }
  }, [apiBase]);

  const refreshAudit = useCallback(async () => {
    try {
      const [caps, intr, evts] = await Promise.all([
        callJson<{ capabilities: readonly EngineCapabilitySnapshot[] }>(apiBase, 'GET', '/api/capabilities'),
        callJson<{ interrupted: readonly RunRecord[] }>(apiBase, 'GET', '/api/runs/interrupted'),
        callNdjson<AuditEvent>(apiBase, '/api/events'),
      ]);
      setCapabilities(caps.capabilities);
      setInterrupted(intr.interrupted);
      setEvents(evts);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void refreshCase();
    void refreshAudit();
  }, [refreshCase, refreshAudit]);

  const createCase = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      await callJson(apiBase, 'POST', '/api/case', {
        name: 'ScopePilot2 案件',
        allowedOrigins: ['http://fixture.target.test'],
        deniedOrigins: [],
        limits: { maxRequests: 5000, maxPages: 500, maxDurationMinutes: 60 },
      });
      await callJson(apiBase, 'POST', '/api/authorization', {
        allowedOperationClasses: ['Browse', 'ActiveScan'],
        targetRoles: ['unauthenticated'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可 (デスクトップ)',
        evidenceContent: 'desktop advanced evidence',
      });
      await refreshCase();
      await refreshAudit();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, refreshAudit, refreshCase]);

  const activeItem = items.find((item) => item.route === activeRoute);
  return (
    <div className={styles.root}>
      <nav className={styles.nav} aria-label="Advanced 画面ナビ">
        {items.map((item) => (
          <button
            key={item.screenId}
            type="button"
            className={item.route === activeRoute ? `${styles.navItem} ${styles.navActive}` : styles.navItem}
            onClick={() => setActiveRoute(item.route)}
          >
            {item.screenId} {item.label}
          </button>
        ))}
      </nav>
      <div className={styles.content}>
        <Text size={400} weight="semibold">
          {activeItem === undefined ? '' : `${activeItem.screenId} ${activeItem.label}`}
        </Text>
        {error !== '' && (
          <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
            {`Error: ${error}`}
          </Text>
        )}
        {activeRoute === 'advanced.dashboard' && (
          <>
            <div className={styles.section}>
              <Text weight="semibold">案件</Text>
              {caseRecord !== null ? (
                <>
                  <Text>{`案件「${caseRecord.name}」 (revision ${caseRecord.revision})`}</Text>
                  <Text className={styles.muted}>{`対象 Origin: ${caseRecord.scope.allowedOrigins.join(', ')}`}</Text>
                  <Text className={styles.muted}>{`上限: ${caseRecord.scope.limits.maxRequests} req / ${caseRecord.scope.limits.maxPages} page / ${caseRecord.scope.limits.maxDurationMinutes} 分`}</Text>
                </>
              ) : caseMissing ? (
                <>
                  <Text>案件が未作成です。</Text>
                  <Button disabled={busy} onClick={() => void createCase()}>
                    案件を作成する
                  </Button>
                </>
              ) : (
                <Text>取得中…</Text>
              )}
            </div>
            <div className={styles.section}>
              <Text weight="semibold">外部 engine 能力 (保証等級)</Text>
              <Table size="small" aria-label="engine 能力表">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>engine</TableHeaderCell>
                    <TableHeaderCell>版</TableHeaderCell>
                    <TableHeaderCell>由来</TableHeaderCell>
                    {CONTROL_ASPECTS.map((aspect) => (
                      <TableHeaderCell key={aspect}>{aspect}</TableHeaderCell>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {capabilities.map((cap) => (
                    <TableRow key={`${cap.engineKind}-${cap.engineVersion}`}>
                      <TableCell>{cap.engineKind}</TableCell>
                      <TableCell>{cap.engineVersion}</TableCell>
                      <TableCell>
                        {cap.source === 'fixture' ? 'fixture (実測ではない)' : 'measured'}
                      </TableCell>
                      {CONTROL_ASPECTS.map((aspect) => (
                        <TableCell key={aspect}>{cap.guaranteeLevels[aspect]}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className={styles.section}>
              <Text weight="semibold">前回中断された run (design/22 §6)</Text>
              {interrupted.length === 0 ? (
                <Text className={styles.muted}>ありません。実行中のまま残った run は検出されませんでした。</Text>
              ) : (
                interrupted.map((run) => (
                  <Badge key={run.runId} appearance="ghost">{`${run.runId}: ${run.state} (${run.stopReason ?? 'unknown'})`}</Badge>
                ))
              )}
            </div>
          </>
        )}
        {activeRoute === 'advanced.jobs' && (
          <div className={styles.section}>
            <Text weight="semibold">監査 event ({events.length} 件)</Text>
            {events.length === 0 ? (
              <Text className={styles.muted}>監査 event はまだありません。</Text>
            ) : (
              events.map((event) => (
                <Text key={event.eventId} block>
                  {`#${event.eventId} ${event.type} ${event.at}`}
                </Text>
              ))
            )}
          </div>
        )}
        {activeRoute !== 'advanced.dashboard' && activeRoute !== 'advanced.jobs' && (
          <Text className={styles.muted}>この画面は未実装です (後続増分で提供します)。</Text>
        )}
      </div>
    </div>
  );
}
