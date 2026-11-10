/** A32 Fuzzer: bounded query insertion with explicit transport and asynchronous progress. */
import React, { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Field, Input, MessageBar, ProgressBar, Select, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Textarea, makeStyles } from '@fluentui/react-components';
import type { FuzzAttack, FuzzRunView } from '@scopepilot2/contracts';
import { useRuntimeCapabilities } from './use-runtime-capabilities.ts';

interface PayloadSet { name: string; source: string; version: string; license: string; sha256: string; values: readonly string[] }
interface Position { name: string; payloadSet: string; values: string }
async function call<T>(base: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${base}/api/fuzzer/${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
  return result as T;
}
const styles = makeStyles({ section: { display: 'flex', flexDirection: 'column', gap: '12px' } });
const lines = (text: string) => text.split('\n');
export function FuzzerScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const runtime = useRuntimeCapabilities(apiBase);
  const css = styles();
  const [sets, setSets] = useState<readonly PayloadSet[]>([]);
  const [transport, setTransport] = useState<string>('Loading transport');
  const [targetUrl, setTargetUrl] = useState('');
  const [method, setMethod] = useState<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'>('GET');
  const [bodyTemplate, setBodyTemplate] = useState('');
  const [contentType, setContentType] = useState('application/x-www-form-urlencoded');
  const editor = useRef<HTMLTextAreaElement>(null);
  const [role, setRole] = useState('');
  const [positions, setPositions] = useState<Position[]>([]);
  const [attack, setAttack] = useState<FuzzAttack>('sniper');
  const [cap, setCap] = useState('200');
  const [rps, setRps] = useState('2');
  const [run, setRun] = useState<FuzzRunView | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [changedOnly, setChangedOnly] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [registration, setRegistration] = useState({ name: '', source: '', version: '', license: '', values: '' });
  const poll = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const active = pending || run?.state === 'Running';
  useEffect(() => {
    let disposed = false;
    void Promise.all([call<{ sets: PayloadSet[] }>(apiBase, 'payload-sets'), call<{ transport: string }>(apiBase, 'status')])
      .then(([catalog, status]) => { if (!disposed) { setSets(catalog.sets); setTransport(status.transport); } })
      .catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [apiBase]);
  useEffect(() => {
    if (run?.state !== 'Running') return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await call<FuzzRunView>(apiBase, `jobs?runId=${encodeURIComponent(run.runId)}`);
        if (!disposed) { setRun(next); if (next.state === 'Running') poll.current = setTimeout(() => void refresh(), 300); }
      } catch (cause) { if (!disposed) { setError(String(cause)); poll.current = setTimeout(() => void refresh(), 1000); } }
    };
    poll.current = setTimeout(() => void refresh(), 100);
    return () => { disposed = true; clearTimeout(poll.current); };
  }, [apiBase, run?.runId, run?.state]);
  const update = (index: number, patch: Partial<Position>) => setPositions(previous => previous.map((p, i) => i === index ? { ...p, ...patch } : p));
  const values = (p: Position) => p.payloadSet === '' ? lines(p.values) : sets.find(s => s.name === p.payloadSet)?.values ?? [];
  const counts = positions.map(p => values(p).length);
  const estimate = counts.length === 0 ? 0 : attack === 'sniper' ? counts.reduce((a, b) => a + b, 0)
    : attack === 'battering-ram' ? counts[0]! : attack === 'pitchfork' ? Math.min(...counts) : counts.reduce((a, b) => a * b, 1);
  const start = async () => {
    setPending(true); setError(''); setSelected(null);
    try { setRun(await call<FuzzRunView>(apiBase, 'jobs', {
      targetUrl, request: { method, bodyTemplate, contentType }, attack, maxRequests: Number(cap), requestsPerSecond: Number(rps),
      ...(role.trim() === '' ? {} : { role: role.trim() }),
      positions: positions.map(p => ({ name: p.name, values: values(p), ...(p.payloadSet === '' ? {} : { payloadSet: p.payloadSet }) })),
    })); } catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  const register = async () => {
    setPending(true); setError('');
    try {
      const payload = lines(registration.values);
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
      await call(apiBase, 'payload-sets', { ...registration, values: payload, sha256: hash });
      setSets((await call<{ sets: PayloadSet[] }>(apiBase, 'payload-sets')).sets);
    } catch (cause) { setError(String(cause)); } finally { setPending(false); }
  };
  const row = run?.rows.find(item => item.index === selected);
  return <div className={css.section}>
    <Text>Fuzzer: select query or body insertion positions, assign payloads, then run within case scope and request limits.</Text>
    <MessageBar intent={transport === 'fixture' ? 'warning' : 'info'}>
      {transport === 'fixture' ? 'fixture mode: simulated responses; no HTTP requests are sent.' : `Transport: ${transport}`}
    </MessageBar>
    {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
    <fieldset disabled={active} className={css.section}><legend>Base request / insertion positions</legend>
      <Field label="Target URL"><Input value={targetUrl} onChange={(_, d) => { setTargetUrl(d.value); setPositions([]); }} /></Field>
      <Field label="Session role (optional)"><Input value={role} onChange={(_, d) => setRole(d.value)} /></Field>
      <Field label="Method"><Select value={method} onChange={(_, d) => setMethod(d.value as typeof method)}>{['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map(m => <option key={m}>{m}</option>)}</Select></Field>
      <Field label="Content type"><Input value={contentType} onChange={(_, d) => setContentType(d.value)} /></Field>
      <Field label="Request body (select text, then add insertion)"><Textarea ref={editor} value={bodyTemplate} rows={5} onChange={(_, d) => { setBodyTemplate(d.value); setPositions(previous => previous.filter(p => !p.name.startsWith('body:'))); }} /></Field>
      <Button onClick={() => {
        const start = editor.current?.selectionStart ?? 0;
        const end = editor.current?.selectionEnd ?? start;
        const next = `${bodyTemplate.slice(0, start)}\u00a7${bodyTemplate.slice(start, end)}\u00a7${bodyTemplate.slice(end)}`;
        setBodyTemplate(next);
        setPositions(previous => [...previous.filter(p => !p.name.startsWith('body:')), ...[...next.matchAll(/\u00a7([^\u00a7]*)\u00a7/g)].map((_, i) => ({ name: `body:${i + 1}`, payloadSet: '', values: '' }))]);
      }}>Add body insertion</Button>
      <Button onClick={() => { try {
        const url = new URL(targetUrl);
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('HTTP(S) URL required');
        setPositions(previous => [...previous.filter(p => p.name.startsWith('body:')), ...[...new Set(url.searchParams.keys())].map(name => ({ name, payloadSet: '', values: '' }))]);
      } catch (cause) { setError(String(cause)); } }}>Detect query positions</Button>
      <Text>Select parameters to replace. Unselected values stay unchanged. Repeated query names are replaced together.</Text>
      {positions.map((p, i) => <div key={p.name} className={css.section}>
        <Text weight="semibold">Insertion: {p.name}</Text>
        <Field label={`Payload set for ${p.name}`}><Select value={p.payloadSet} onChange={(_, d) => update(i, { payloadSet: d.value })}>
          <option value="">Direct input</option>{sets.map(s => <option key={s.name} value={s.name}>{s.name} ({s.values.length})</option>)}
        </Select></Field>
        {p.payloadSet === '' ? <Field label={`Payloads for ${p.name} (one per line; empty line = empty value)`}><Textarea value={p.values} onChange={(_, d) => update(i, { values: d.value })} /></Field>
          : <Text>{sets.filter(s => s.name === p.payloadSet).map(s => `${s.source} / ${s.version} / ${s.license} / ${s.sha256}`).join('')}</Text>}
        <Button onClick={() => setPositions(previous => previous.filter((_, index) => index !== i))}>Remove {p.name}</Button>
      </div>)}
      <Field label="Attack type"><Select value={attack} onChange={(_, d) => setAttack(d.value as FuzzAttack)}>
        <option value="sniper">Sniper - one position at a time</option><option value="battering-ram">Battering ram - first set in all positions</option>
        <option value="pitchfork">Pitchfork - matching rows, stop at shortest set</option><option value="cluster-bomb">Cluster bomb - all combinations</option>
      </Select></Field>
      <Field label="Maximum requests (also capped by case limit)"><Input type="number" min={1} max={10000} value={cap} onChange={(_, d) => setCap(d.value)} /></Field>
      <Field label="Requests per second (1-2)"><Input type="number" min={1} max={2} value={rps} onChange={(_, d) => setRps(d.value)} /></Field>
      <Text>Estimated requests: {estimate}. Query values are URL encoded once; body insertions use raw values. Battering ram uses the first position set.</Text>
      <Button appearance="primary" disabled={positions.length === 0 || estimate > Number(cap) || !Number.isInteger(Number(cap)) || Number(cap) < 1} onClick={() => void start()}>Run Fuzzer</Button>
    </fieldset>
    {run && <div className={css.section}>
      <Text role="status">{run.transport} / {run.state}: {run.sent} / {run.total}</Text>
      <ProgressBar value={run.total === 0 ? 0 : run.sent / run.total} />
      <Button disabled={run.state !== 'Running'} onClick={() => void call<FuzzRunView>(apiBase, 'stop', { runId: run.runId }).then(setRun).catch(cause => setError(String(cause)))}>Stop Fuzzer</Button>
      {run.error && <MessageBar intent="error">{run.error}</MessageBar>}
      <Text>Diff compares status and body hash with the first response; length delta is in bytes. This is not a vulnerability verdict. HTTP bodies are not retained.</Text>
      <Checkbox label="Only changed responses" checked={changedOnly} onChange={(_, d) => setChangedOnly(d.checked === true)} />
      <Table aria-label="Fuzzer results"><TableHeader><TableRow>{['Payload', 'Status', 'Length (bytes)', 'Time (ms)', 'Length diff', 'Body/status diff', 'Details'].map(label => <TableHeaderCell key={label}>{label}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>{run.rows.filter(item => !changedOnly || item.changed).map(item => <TableRow key={item.index}>
          <TableCell>{item.payload.join(' | ')}</TableCell><TableCell>{item.status}</TableCell><TableCell>{item.contentLength}</TableCell><TableCell>{item.elapsedMs}</TableCell>
          <TableCell>{item.lengthDiff}</TableCell><TableCell>{item.changed ? 'Changed' : 'Same'}</TableCell><TableCell><Button onClick={() => setSelected(item.index)}>Response {item.index + 1}</Button></TableCell>
        </TableRow>)}</TableBody></Table>
      {row && <Text>Response {row.index + 1}: status {row.status}; body hash {row.bodyHash}; cluster {row.status}|{row.contentLength}|{row.bodyHash}</Text>}
    </div>}
    <details><summary>Register payload set (source / version / license / SHA-256)</summary><div className={css.section}>
      {(['name', 'source', 'version', 'license'] as const).map(key => <Field key={key} label={key}><Input disabled={active} value={registration[key]} onChange={(_, d) => setRegistration(previous => ({ ...previous, [key]: d.value }))} /></Field>)}
      <Field label="Values (one per line)"><Textarea disabled={active} value={registration.values} onChange={(_, d) => setRegistration(previous => ({ ...previous, values: d.value }))} /></Field>
      <Button disabled={active || !registration.name.trim() || !registration.source.trim() || !registration.version.trim() || !registration.license.trim()} onClick={() => void register()}>Register payload set</Button>
    </div></details>
  </div>;
}
