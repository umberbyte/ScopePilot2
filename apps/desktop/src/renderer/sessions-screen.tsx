/**
 * A09 Sessions / Roles / Business logic。`docs/detailed-design/f09-authentication-session.md`。
 * login flow の登録 (step 構成は domain 検証・secret は参照のみ)・login の実行 (秘密値は
 * この実行の間だけ使う)・session refresh・role ごとの cookie jar 割当 (共有警告) を扱う。
 * 業務ロジック検証 (design/f17) もこの画面から実行する。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageBar, Button, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';

interface SessionView {
  readonly role: string;
  readonly flowVersion: string;
  readonly stepCount: number;
  readonly secretReferences: readonly string[];
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
  const [stepsText, setStepsText] = useState('[\n  { "kind": "navigate", "target": "http://fixture.target.test/login.php" },\n  { "kind": "fill", "target": "#username", "secretReference": "vault://admin-user" },\n  { "kind": "fill", "target": "#password", "secretReference": "vault://admin-pass" },\n  { "kind": "click", "target": "input[type=submit]" },\n  { "kind": "assert", "target": "Fixture Target Home" }\n]');
  const [loginBaseUrl, setLoginBaseUrl] = useState('http://fixture.target.test');
  const [loginExpectedPrefix, setLoginExpectedPrefix] = useState('http://fixture.target.test/');
  const [loginProxy, setLoginProxy] = useState('');
  const [secretInputs, setSecretInputs] = useState<Readonly<Record<string, string>>>({});
  const [loginResult, setLoginResult] = useState<{ role: string; authenticated: boolean; finalUrl: string; cookieNames: readonly string[]; sharedCookieNames: boolean } | null>(null);
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
          throw new Error(t('a09.stepsInvalid'));
        }
        const result = await callJson<{ flow: { role: string; stepCount: number } }>(apiBase, 'POST', '/api/sessions/flows', { role, flowVersion, steps });
        setNotice(t('a09.flowRegistered', { role: result.flow.role, stepCount: result.flow.stepCount }));
      }),
    [apiBase, flowVersion, role, run, stepsText],
  );

  const refresh = useCallback(
    (targetRole: string) =>
      run(async () => {
        const result = await callJson<{ outcome: string; sessionRevision: number }>(apiBase, 'POST', '/api/sessions/refresh', { role: targetRole });
        setNotice(
          result.outcome === 'refreshed'
            ? t('a09.sessionRefreshed', { role: targetRole, revision: result.sessionRevision })
            : t('a09.refreshStopped', { role: targetRole }),
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
            ? t('a09.cookiesShared', { role: result.role })
            : t('a09.cookiesAssigned', { role: result.role }),
        );
      }),
    [apiBase, cookieNames, role, run],
  );

  const executeLogin = useCallback(
    () =>
      run(async () => {
        const references = sessions.find((session) => session.role === role)?.secretReferences ?? [];
        if (references.length === 0) {
          throw new Error(t('a09.loginNeedsFlow'));
        }
        const secretValues: Record<string, string> = {};
        for (const reference of references) {
          secretValues[reference] = secretInputs[reference] ?? '';
        }
        const result = await callJson<{ role: string; authenticated: boolean; finalUrl: string; cookieNames: readonly string[]; sharedCookieNames: boolean }>(apiBase, 'POST', '/api/sessions/login', {
          role,
          baseUrl: loginBaseUrl,
          expectedUrlPrefix: loginExpectedPrefix,
          secretValues,
          ...(loginProxy.trim() === '' ? {} : { proxyServer: loginProxy.trim() }),
        });
        setLoginResult(result);
        // 秘密値は実行後に破棄する (メモリに保持し続けない — design/f09)。
        setSecretInputs({});
      }),
    [apiBase, loginBaseUrl, loginExpectedPrefix, loginProxy, role, run, secretInputs, sessions],
  );

  // 現在入力中の role の flow が参照する秘密値 (登録後に一覧から取れる)。
  const loginReferences = sessions.find((session) => session.role === role)?.secretReferences ?? [];

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
        <MessageBar intent="error">
          {`Error: ${error}`}
        </MessageBar>
      )}
      {notice !== '' && <Text role="status">{notice}</Text>}
      <Text className={styles.muted}>{t('a09.intro')}</Text>
      <Text weight="semibold">{t('a09.flowTitle')}</Text>
      <Field label={t('a09.roleLabel')}>
        <Input value={role} onChange={(_, data) => setRole(data.value)} />
      </Field>
      <Field label={t('a09.flowVersionLabel')}>
        <Input value={flowVersion} onChange={(_, data) => setFlowVersion(data.value)} />
      </Field>
      <Field label={t('a09.stepsLabel')}>
        <Textarea value={stepsText} onChange={(_, data) => setStepsText(data.value)} rows={6} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void registerFlow()}>
        {t('a09.register')}
      </Button>
      <Text weight="semibold">{t('a09.loginTitle')}</Text>
      <Text className={styles.muted}>{t('a09.loginIntro')}</Text>
      <Field label={t('a09.baseUrlLabel')}>
        <Input value={loginBaseUrl} onChange={(_, data) => setLoginBaseUrl(data.value)} />
      </Field>
      <Field label={t('a09.expectedPrefixLabel')}>
        <Input value={loginExpectedPrefix} onChange={(_, data) => setLoginExpectedPrefix(data.value)} />
      </Field>
      <Field label={t('a09.proxyLabel')}>
        <Input value={loginProxy} onChange={(_, data) => setLoginProxy(data.value)} />
      </Field>
      {loginReferences.length === 0 ? (
        <Text className={styles.muted}>{t('a09.loginNeedsFlow')}</Text>
      ) : (
        loginReferences.map((reference) => (
          <Field key={reference} label={t('a09.secretLabel', { reference })}>
            <Input
              type="password"
              value={secretInputs[reference] ?? ''}
              onChange={(_, data) => setSecretInputs((current) => ({ ...current, [reference]: data.value }))}
            />
          </Field>
        ))
      )}
      <Button appearance="primary" disabled={busy} onClick={() => void executeLogin()}>
        {t('a09.loginRun')}
      </Button>
      {loginResult !== null && loginResult.authenticated && (
        <Text role="status">
          {t('a09.loginResult', { role: loginResult.role, result: t('a09.authenticated'), finalUrl: loginResult.finalUrl, cookies: loginResult.cookieNames.join(', ') })}
          {loginResult.sharedCookieNames ? ` ${t('a09.cookiesShared', { role: loginResult.role })}` : ''}
        </Text>
      )}
      {loginResult !== null && !loginResult.authenticated && (
        <MessageBar intent="warning">
          {t('a09.loginResult', { role: loginResult.role, result: t('a09.unauthenticated'), finalUrl: loginResult.finalUrl, cookies: loginResult.cookieNames.join(', ') || '—' })}
        </MessageBar>
      )}
      <Field label={t('a09.cookiesLabel')}>
        <Input value={cookieNames} onChange={(_, data) => setCookieNames(data.value)} />
      </Field>
      <Button disabled={busy} onClick={() => void assignCookies()}>
        {t('a09.assignCookies')}
      </Button>
      <Text weight="semibold">{t('a09.sessionsTitle', { count: sessions.length })}</Text>
      {sessions.length === 0 ? (
        <Text className={styles.muted}>{t('a09.empty')}</Text>
      ) : (
        <Table size="small" aria-label={t('a09.sessionsTitle', { count: sessions.length })}>
          <TableHeader>
            <TableRow>
              <TableHeaderCell>{t('a09.col.role')}</TableHeaderCell>
              <TableHeaderCell>{t('a09.col.flowVersion')}</TableHeaderCell>
              <TableHeaderCell>{t('a09.col.stepCount')}</TableHeaderCell>
              <TableHeaderCell>{t('a09.col.secrets')}</TableHeaderCell>
              <TableHeaderCell>{t('a09.col.cookies')}</TableHeaderCell>
              <TableHeaderCell>{t('a09.col.revision')}</TableHeaderCell>
              <TableHeaderCell>{t('a09.col.actions')}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.map((session) => (
              <TableRow key={session.role}>
                <TableCell>{session.role}</TableCell>
                <TableCell>{session.flowVersion}</TableCell>
                <TableCell>{String(session.stepCount)}</TableCell>
                <TableCell>{session.secretReferences.join(', ') || '—'}</TableCell>
                <TableCell>{session.cookieNames.join(', ') || '—'}</TableCell>
                <TableCell>{String(session.sessionRevision)}</TableCell>
                <TableCell>
                  <Button size="small" disabled={busy} onClick={() => void refresh(session.role)}>
                    {t('a09.refresh')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Text weight="semibold">{t('a09.bizTitle')}</Text>
      <Text className={styles.muted}>{t('a09.bizIntro')}</Text>
      <Field label={t('a09.rolesLabel')}>
        <Input value={bizRoles} onChange={(_, data) => setBizRoles(data.value)} />
      </Field>
      <Field label={t('a09.expressionLabel')}>
        <Input value={bizExpression} onChange={(_, data) => setBizExpression(data.value)} />
      </Field>
      <Field label={t('a09.expectedLabel')}>
        <Input value={bizExpected} onChange={(_, data) => setBizExpected(data.value)} />
      </Field>
      <Button appearance="primary" disabled={busy} onClick={() => void runBusinessCheck()}>
        {t('a09.bizRun')}
      </Button>
      {bizResult !== null && (
        <div className={styles.section}>
          <Text role="status">{t('a09.bizResult', { status: bizResult.status, comparison: bizResult.comparison.outcome, restore: bizResult.restore.outcome, evidence: bizResult.matrix.evidenceSeparated ? t('a09.evidenceYes') : t('a09.evidenceNo') })}</Text>
          <Text className={styles.muted}>{t('a09.observations', { observations: bizResult.observations.map((observation) => `${observation.role}=${observation.observation ?? t('a09.observationMissing')}`).join('・') })}</Text>
        </div>
      )}
    </div>
  );
}
