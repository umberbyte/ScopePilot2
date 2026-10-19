/**
 * A09 Sessions / Roles / Business logic。`docs/detailed-design/f09-authentication-session.md`。
 * login flow の登録 (step 構成は domain 検証・secret は参照のみ)、session refresh、
 * role ごとの cookie jar 割当 (共有警告) を扱う。業務ロジック検証 (design/f17) は後続増分。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';

interface SessionView {
  readonly role: string;
  readonly flowVersion: string;
  readonly stepCount: number;
  readonly cookieNames: readonly string[];
  readonly sessionRevision: number;
}

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

const useStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: '4px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

export function SessionsScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [sessions, setSessions] = useState<readonly SessionView[]>([]);
  const [role, setRole] = useState('admin');
  const [flowVersion, setFlowVersion] = useState('flow-1');
  const [stepsText, setStepsText] = useState('[\n  { "kind": "navigate", "target": "http://fixture.target.test/login.php" },\n  { "kind": "fill", "target": "#username", "secretReference": "vault://admin-user" },\n  { "kind": "click", "target": "input[type=submit]" }\n]');
  const [cookieNames, setCookieNames] = useState('PHPSESSID');
  const [bizRoles, setBizRoles] = useState('admin, guest');
  const [bizExpression, setBizExpression] = useState('body.contains');
  const [bizExpected, setBizExpected] = useState('business-response:admin');
  const [bizResult, setBizResult] = useState<{ status: string; comparison: { outcome: string }; restore: { outcome: string }; matrix: { evidenceSeparated: boolean }; observations: readonly { role: string; observation: string | null }[] } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const body = await callJson<{ sessions: readonly SessionView[] }>(apiBase, 'GET', '/api/sessions');
      setSessions(body.sessions);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
        await load();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const registerFlow = useCallback(
    () =>
      run(async () => {
        let steps: readonly unknown[];
        try {
          steps = JSON.parse(stepsText) as readonly unknown[];
        } catch {
          throw new Error('steps が JSON 配列として解析できません');
        }
        const result = await callJson<{ flow: { role: string; stepCount: number } }>(apiBase, 'POST', '/api/sessions/flows', { role, flowVersion, steps });
        setNotice(`${result.flow.role} の flow を登録しました (${result.flow.stepCount} step・secret は参照のみ保持)`);
      }),
    [apiBase, flowVersion, role, run, stepsText],
  );

  const refresh = useCallback(
    (targetRole: string) =>
      run(async () => {
        const result = await callJson<{ outcome: string; sessionRevision: number }>(apiBase, 'POST', '/api/sessions/refresh', { role: targetRole });
        setNotice(
          result.outcome === 'refreshed'
            ? `${targetRole} の session を更新しました (revision ${result.sessionRevision})`
            : `${targetRole} の refresh は lockout 回避のため停止しました`,
        );
      }),
    [apiBase, run],
  );

  const assignCookies = useCallback(
    () =>
      run(async () => {
        const names = cookieNames.split(',').map((name) => name.trim()).filter((name) => name !== '');
        const result = await callJson<{ role: string; shared: boolean }>(apiBase, 'POST', '/api/sessions/cookies', { role, cookieNames: names });
        setNotice(
          result.shared
            ? `${result.role} の cookie は他 role と同名のため共有と判定されました (role 間で jar を共有しません)`
            : `${result.role} に cookie jar を割り当てました`,
        );
      }),
    [apiBase, cookieNames, role, run],
  );

  const runBusinessCheck = useCallback(
    () =>
      run(async () => {
        const roles = bizRoles.split(',').map((value) => value.trim()).filter((value) => value !== '');
        const result = await callJson<{ status: string; comparison: { outcome: string }; restore: { outcome: string }; matrix: { evidenceSeparated: boolean }; observations: readonly { role: string; observation: string | null }[] }>(apiBase, 'POST', '/api/business-logic/checks', {
          roles,
          targetUrl: 'http://fixture.target.test/admin-only',
          expectation: { expression: bizExpression, args: [bizExpected] },
        });
        setBizResult(result);
      }),
    [apiBase, bizExpected, bizExpression, bizRoles, run],
  );

  return (
    <div className={styles.section}>
      {error !== '' && (
        <Text role="alert" style={{ color: tokens.colorPaletteRedForeground1 }}>
          {`Error: ${error}`}
        </Text>
      )}
      {notice !== '' && <Text role="status">{notice}</Text>}
      <Text className={styles.muted}>
        secret 値は画面・API のどちらにも入れません。flow は参照 (secretReference) のみ持ち、step は最大 10・種別は allowlist (navigate/fill/click/wait/extract/assert) です。
      </Text>
      <Text weight="semibold">login flow の登録</Text>
      <Field label="role">
        <Input value={role} onChange={(_, data) => setRole(data.value)} />
      </Field>
      <Field label="flow 版">
        <Input value={flowVersion} onChange={(_, data) => setFlowVersion(data.value)} />
      </Field>
      <Field label="steps (JSON 配列)">
        <Textarea value={stepsText} onChange={(_, data) => setStepsText(data.value)} rows={6} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void registerFlow()}>
        flow を登録する
      </Button>
      <Field label="cookie 名 (comma 区切・role へ割当)">
        <Input value={cookieNames} onChange={(_, data) => setCookieNames(data.value)} />
      </Field>
      <Button disabled={busy} onClick={() => void assignCookies()}>
        cookie jar を割り当てる
      </Button>
      <Text weight="semibold">{`sessions (${sessions.length} role)`}</Text>
      {sessions.length === 0 ? (
        <Text className={styles.muted}>登録された flow はまだありません。</Text>
      ) : (
        <Table size="small" aria-label="session 一覧">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>role</TableHeaderCell>
              <TableHeaderCell>flow 版</TableHeaderCell>
              <TableHeaderCell>step 数</TableHeaderCell>
              <TableHeaderCell>cookie (名前のみ)</TableHeaderCell>
              <TableHeaderCell>session revision</TableHeaderCell>
              <TableHeaderCell>操作</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.role}>
                <TableCell>{session.role}</TableCell>
                <TableCell>{session.flowVersion}</TableCell>
                <TableCell>{String(session.stepCount)}</TableCell>
                <TableCell>{session.cookieNames.join(', ') || '—'}</TableCell>
                <TableCell>{String(session.sessionRevision)}</TableCell>
                <TableCell>
                  <Button size="small" disabled={busy} onClick={() => void refresh(session.role)}>
                    refresh
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Text weight="semibold">Business logic 検証 (role 差分)</Text>
      <Text className={styles.muted}>
        2 role 以上の差分検証です。認可が CrossRoleTest を許可している必要があります。観測が欠けた role (session 未 refresh) があると inconclusive となり、成功/失敗を推測しません。期待値 DSL は allowlist 演算のみです。
      </Text>
      <Field label="roles (comma 区切)">
        <Input value={bizRoles} onChange={(_, data) => setBizRoles(data.value)} />
      </Field>
      <Field label="期待値 expression (allowlist)">
        <Input value={bizExpression} onChange={(_, data) => setBizExpression(data.value)} />
      </Field>
      <Field label="期待値">
        <Input value={bizExpected} onChange={(_, data) => setBizExpected(data.value)} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void runBusinessCheck()}>
        業務ロジック検証を実行する
      </Button>
      {bizResult !== null && (
        <div className={styles.section}>
          <Text role="status">{`結果: ${bizResult.status} (比較 ${bizResult.comparison.outcome}・restore ${bizResult.restore.outcome}・証拠分離 ${bizResult.matrix.evidenceSeparated ? 'あり' : 'なし'})`}</Text>
          <Text className={styles.muted}>{`観測: ${bizResult.observations.map((observation) => `${observation.role}=${observation.observation ?? '(欠落)'}`).join('・')}`}</Text>
        </div>
      )}
    </div>
  );
}
