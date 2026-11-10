/**
 * A09 Sessions / Roles / Business logic。`docs/detailed-design/f09-authentication-session.md`。
 * login flow の登録 (step 構成は domain 検証・secret は参照のみ)・login の実行 (秘密値は
 * この実行の間だけ使う)・session refresh・role ごとの cookie jar 割当 (共有警告) を扱う。
 * 業務ロジック検証 (design/f17) もこの画面から実行する。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { MessageBar, Button, Checkbox, Select, Field, Input, makeStyles, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';
import type { AuthenticationUser, AuthenticationCapabilities, SessionVerification, CaseRecord } from '@scopepilot2/contracts';
import { AuthenticationMethods } from '@scopepilot2/contracts/authentication';

interface SessionView {
  readonly role: string;
  readonly flowVersion: string;
  readonly stepCount: number;
  readonly secretReferences: readonly string[];
  readonly cookieNames: readonly string[];
  readonly sessionRevision: number;
  readonly verificationUrl: string | null;
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
  const [context, setContext] = useState<CaseRecord | null>(null);
  const [allowedOrigins, setAllowedOrigins] = useState('');
  const [deniedOrigins, setDeniedOrigins] = useState('');
  const [users, setUsers] = useState<readonly AuthenticationUser[]>([]);
  const [capabilities, setCapabilities] = useState<AuthenticationCapabilities | null>(null);
  const [verifications, setVerifications] = useState<readonly SessionVerification[]>([]);
  const [flows, setFlows] = useState<readonly { role: string; flowVersion: string; steps: readonly unknown[] }[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [authorizationRole, setAuthorizationRole] = useState('');
  const [method, setMethod] = useState<AuthenticationUser['method']>('Form');
  const [enabled, setEnabled] = useState(true);
  const [userSelector, setUserSelector] = useState('input[name=username]');
  const [passwordSelector, setPasswordSelector] = useState('input[name=password]');
  const [submitSelector, setSubmitSelector] = useState('button[type=submit]');
  const [successMarker, setSuccessMarker] = useState('');
  const [sessions, setSessions] = useState<readonly SessionView[]>([]);
  const [authHints, setAuthHints] = useState<readonly { documentLabel: string; entries: readonly { role: string; authMethod: string; documentLocation: string }[] }[]>([]);
  const [role, setRole] = useState('admin');
  const [flowVersion, setFlowVersion] = useState('flow-1');
  const [stepsText, setStepsText] = useState('[]');
  const [loginBaseUrl, setLoginBaseUrl] = useState('');
  const [loginExpectedPrefix, setLoginExpectedPrefix] = useState('');
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

  const load = useCallback(async (reloadContext = false) => {
    try {
      const [body, config, caseRecord] = await Promise.all([
        callJson<{ sessions: readonly SessionView[] }>(apiBase, 'GET', '/api/sessions'),
        callJson<{ users: readonly AuthenticationUser[]; capabilities: AuthenticationCapabilities; verifications: readonly SessionVerification[]; flows: readonly { role: string; flowVersion: string; steps: readonly unknown[] }[] }>(apiBase, 'GET', '/api/authentication'),
        callJson<CaseRecord>(apiBase, 'GET', '/api/case').catch(() => null),
      ]);
      setUsers(config.users); setCapabilities(config.capabilities); setVerifications(config.verifications); setFlows(config.flows);
      if (reloadContext) {
        setError('');
        setContext(caseRecord);
        if (caseRecord !== null) {
          setAllowedOrigins(caseRecord.scope.allowedOrigins.join('\n'));
          setDeniedOrigins(caseRecord.scope.deniedOrigins.join('\n'));
        }
      }
      setSessions(body.sessions);
      const authHints = await callJson<{ hints: readonly { documentLabel: string; entries: readonly { role: string; authMethod: string; documentLocation: string }[] }[] }>(apiBase, 'GET', '/api/documents/auth-hints');
      setAuthHints(authHints.hints);
    } catch (cause) {
      setError(String(cause));
    }
  }, [apiBase]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
      } catch (cause) {
        setError(String(cause));
      } finally {
        await load();
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
        setLoginResult(null);
        setSecretInputs({});
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
        setLoginResult(null);
        const references = sessions.find((session) => session.role === role)?.secretReferences ?? [];
        if (references.length === 0) {
          throw new Error(t('a09.loginNeedsFlow'));
        }
        const secretValues: Record<string, string> = {};
        for (const reference of references) {
          secretValues[reference] = secretInputs[reference] ?? '';
        }
        try {
          const result = await callJson<{ role: string; authenticated: boolean; finalUrl: string; cookieNames: readonly string[]; sharedCookieNames: boolean }>(apiBase, 'POST', '/api/sessions/login', {
            role,
            baseUrl: loginBaseUrl,
            expectedUrlPrefix: loginExpectedPrefix,
            secretValues,
            ...(loginProxy.trim() === '' ? {} : { proxyServer: loginProxy.trim() }),
          });
          setLoginResult(result);
          // 秘密値は実行後に破棄する (メモリに保持し続けない — design/f09)。
        } finally { setSecretInputs({}); }
      }),
    [apiBase, loginBaseUrl, loginExpectedPrefix, loginProxy, role, run, secretInputs, sessions],
  );

  useEffect(() => { setSecretInputs({}); setLoginResult(null); }, [role]);

  const selectIdentity = (identity: string): void => {
    setRole(identity);
    const user = users.find((entry) => entry.role === identity);
    setDisplayName(user?.displayName ?? '');
    setAuthorizationRole(user?.authorizationRole ?? '');
    setMethod(user?.method ?? 'Form');
    setEnabled(user?.enabled ?? true);
    const flow = flows.find((entry) => entry.role === identity);
    setFlowVersion(flow?.flowVersion ?? 'flow-1');
    setStepsText(JSON.stringify(flow?.steps ?? [], null, 2));
  };

  const saveUser = () => run(async () => {
    await callJson(apiBase, 'POST', '/api/authentication/users', { role, displayName, authorizationRole, method, enabled });
    setNotice(t('a09.userSaved'));
    setLoginResult(null);
    setSecretInputs({});
  });

  const saveContext = () => run(async () => {
    if (context === null) throw new Error(t('a02.caseMissing'));
    await callJson(apiBase, 'POST', '/api/case/scope', {
      expectedRevision: context.revision,
      allowedOrigins: allowedOrigins.split('\n').map((line) => line.trim()).filter(Boolean),
      deniedOrigins: deniedOrigins.split('\n').map((line) => line.trim()).filter(Boolean),
      limits: context.scope.limits,
    });
    setLoginResult(null);
    setNotice(t('a09.contextSaved'));
    await load(true);
  });

  const verify = (identity: string) => run(async () => {
    const result = await callJson<SessionVerification>(apiBase, 'POST', '/api/sessions/verify', { role: identity });
    setNotice(t('a09.verificationResult', { role: identity, state: result.state, at: result.checkedAt, reason: result.reason }));
    setLoginResult(null);
  });

  const buildForm = (): void => {
    setStepsText(JSON.stringify([
      { kind: 'navigate', target: loginBaseUrl || '/login' },
      { kind: 'fill', target: userSelector, secretReference: `credential:${role}:username` },
      { kind: 'fill', target: passwordSelector, secretReference: `credential:${role}:password` },
      { kind: 'click', target: submitSelector },
      { kind: 'assert', target: successMarker },
    ], null, 2));
  };

  // 現在入力中の role の flow が参照する秘密値 (登録後に一覧から取れる)。
  const loginReferences = sessions.find((session) => session.role === role)?.secretReferences ?? [];

  const runBusinessCheck = useCallback(
    () =>
      run(async () => {
        const roles = bizRoles.split(',').map((value) => value.trim()).filter((value) => value !== '');
        const result = await callJson<{ status: string; comparison: { outcome: string }; restore: { outcome: string }; matrix: { evidenceSeparated: boolean }; observations: readonly { role: string; observation: string | null }[] }>(apiBase, 'POST', '/api/business-logic/checks', {
          roles,
          targetUrl: loginBaseUrl,
          expectation: { expression: bizExpression, args: [bizExpected] },
        });
        setBizResult(result);
      }),
    [apiBase, bizExpected, bizExpression, bizRoles, loginBaseUrl, run],
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
      <MessageBar intent="info">{t('a09.capabilityDisclosure', { login: capabilities?.login ?? 'unavailable', engine: capabilities?.loginEngineVersion ?? '-', verification: capabilities?.verification ?? 'unavailable', verificationEngine: capabilities?.verificationEngineVersion ?? '-' })}</MessageBar>
      <Text weight="semibold">{t('a09.contextTitle')}</Text>
      {context === null ? <Text>{t('a02.caseMissing')}</Text> : <>
        <Text>{t('a09.contextIdentity', { name: context.name, id: context.caseId, revision: context.revision })}</Text>
        <Field label={t('a02.allowedLabel')}><Textarea value={allowedOrigins} onChange={(_, data) => setAllowedOrigins(data.value)} rows={3} /></Field>
        <Field label={t('a02.deniedLabel')}><Textarea value={deniedOrigins} onChange={(_, data) => setDeniedOrigins(data.value)} rows={3} /></Field>
        <Button disabled={busy} onClick={() => void saveContext()}>{t('a09.saveContext')}</Button>
        <Button disabled={busy} onClick={() => void load(true)}>{t('a02.reload')}</Button>
      </>}
      <Text weight="semibold">{t('a09.usersTitle')}</Text>
      <Text className={styles.muted}>{t('a09.usersHelp')}</Text>
      {users.map((user) => <Button key={user.role} disabled={busy} onClick={() => selectIdentity(user.role)}>{user.displayName} / {user.role} / {user.authorizationRole} / {user.method} / {user.enabled ? t('a09.enabled') : t('a09.disabled')}</Button>)}
      <Field label={t('a09.roleLabel')}>
        <Input disabled={busy} value={role} onChange={(_, data) => selectIdentity(data.value)} />
      </Field>
      <Field label={t('a09.displayName')}><Input value={displayName} onChange={(_, data) => setDisplayName(data.value)} /></Field>
      <Field label={t('a09.authorizationRole')}><Input value={authorizationRole} onChange={(_, data) => setAuthorizationRole(data.value)} /></Field>
      <Field label={t('a09.method')}><Select value={method} onChange={(_, data) => setMethod(data.value as AuthenticationUser['method'])}>{AuthenticationMethods.map((value) => <option key={value} value={value}>{value}</option>)}</Select></Field>
      <Checkbox checked={enabled} label={t('a09.enabled')} onChange={(_, data) => setEnabled(data.checked === true)} />
      {method !== 'Form' && <MessageBar intent="warning">{t('a09.methodUnavailable')}</MessageBar>}
      <Button disabled={busy || context === null} onClick={() => void saveUser()}>{t('a09.saveUser')}</Button>
      <Text weight="semibold">{t('a09.flowTitle')}</Text>
      {authHints.length > 0 && (
        <Text className={styles.muted}>
          {t('a09.authHintReference', {
            entries: authHints
              .flatMap((hint) => hint.entries.map((entry) => t('a09.authHintEntry', { role: entry.role, method: entry.authMethod, label: hint.documentLabel, location: entry.documentLocation })))
              .join('・'),
          })}
        </Text>
      )}
      <Field label={t('a09.flowVersionLabel')}>
        <Input value={flowVersion} onChange={(_, data) => setFlowVersion(data.value)} />
      </Field>
      <Text className={styles.muted}>{t('a09.formHelp')}</Text>
      <Field label={t('a09.userSelector')}><Input value={userSelector} onChange={(_, data) => setUserSelector(data.value)} /></Field>
      <Field label={t('a09.passwordSelector')}><Input value={passwordSelector} onChange={(_, data) => setPasswordSelector(data.value)} /></Field>
      <Field label={t('a09.submitSelector')}><Input value={submitSelector} onChange={(_, data) => setSubmitSelector(data.value)} /></Field>
      <Field label={t('a09.successMarker')}><Input value={successMarker} onChange={(_, data) => setSuccessMarker(data.value)} /></Field>
      <Button disabled={busy || successMarker.trim() === ''} onClick={buildForm}>{t('a09.buildForm')}</Button>
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
      <Button appearance="primary" disabled={busy || capabilities?.login !== 'adapter' || method !== 'Form' || !enabled} onClick={() => void executeLogin()}>
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
      <Text className={styles.muted}>{t('a09.verificationHelp')}</Text>
      {verifications.map((entry) => <Text key={entry.role}>{t('a09.verificationResult', { role: entry.role, state: entry.state, at: entry.checkedAt, reason: entry.reason })}</Text>)}
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
                  <Button size="small" disabled={busy || capabilities?.login === 'adapter'} onClick={() => void refresh(session.role)}>
                    {t('a09.refresh')}
                  </Button>
                  <Button size="small" disabled={busy || capabilities?.verification !== 'adapter' || session.verificationUrl === null} onClick={() => void verify(session.role)}>{t('a09.verify')}</Button>
                  <Button size="small" disabled={busy} onClick={() => selectIdentity(session.role)}>{t('a09.editIdentity')}</Button>
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
