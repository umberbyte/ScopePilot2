import type { FingerprintResult } from '@scopepilot2/contracts';
import React, { useCallback, useState } from 'react';
import { MessageBar, Button, Field, makeStyles, Text, Textarea, tokens } from '@fluentui/react-components';
import { t } from './resources.ts';
import { toolJson } from './tools-api.ts';
const useStyles = makeStyles({ section: { display: 'flex', flexDirection: 'column', gap: '12px' }, muted: { color: tokens.colorNeutralForeground3 }, chips: { display: 'flex', gap: '4px', flexWrap: 'wrap' } });
const CODECS = ['base64', 'url', 'hex', 'html-entity', 'gzip', 'deflate-raw'] as const;
interface DecodeResult {
  readonly outputText?: string;
  readonly outputBase64: string;
  readonly outputBytes: number;
}


export function DecoderScreen({ apiBase }: { apiBase: string }): React.ReactElement {
  const styles = useStyles();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inputText, setInputText] = useState('');
  const [chain, setChain] = useState<readonly string[]>([]);
  const [decodeResult, setDecodeResult] = useState<DecodeResult | null>(null);
  const [fingerprints, setFingerprints] = useState<FingerprintResult | null>(null);
  const runDecode = useCallback(async () => {
    setBusy(true);
    setError('');
    setDecodeResult(null);
    try {
      setDecodeResult(await toolJson<DecodeResult>(apiBase, '/api/tools/decode', { inputText, codecs: chain }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  }, [apiBase, chain, inputText]);

  return <section className={styles.section} aria-label="Decoder">
      <Text>{t('tools.decoderPurpose')}</Text>
      <Text>{t('tools.noTraffic')}</Text>
      {error !== '' && <MessageBar intent="error">{error}</MessageBar>}
      <Text weight="semibold">{t('a10.decoderTitle')}</Text>
      <Field label={t('a10.inputLabel')}>
        <Textarea disabled={busy} value={inputText} onChange={(_, data) => { setInputText(data.value); setDecodeResult(null); setFingerprints(null); }} rows={3} />
      </Field>
      <div className={styles.chips}>
        {CODECS.map((codec) => (
          <Button key={codec} size="small" disabled={busy} onClick={() => { setChain((current) => [...current, codec]); setDecodeResult(null); }}>
            {t('a10.addCodec', { codec })}
          </Button>
        ))}
      </div>
      <Text className={styles.muted}>{chain.length === 0 ? t('a10.chainEmpty') : t('a10.chainBuilt', { chain: chain.join(' → ') })}</Text>
      {chain.length > 0 && (
        <Button size="small" disabled={busy} onClick={() => { setChain((current) => current.slice(0, -1)); setDecodeResult(null); }}>
          {t('a10.removeLastCodec')}
        </Button>
      )}
      <Button appearance="primary" disabled={busy || chain.length === 0 || inputText === ''} onClick={() => void runDecode()}>
        {t('a10.decode')}
      </Button>
      {decodeResult !== null && (
        <div className={styles.section}>
          <Text>{t('a10.output', { bytes: decodeResult.outputBytes })}</Text>
          <Text block style={{ whiteSpace: 'pre-wrap' }}>
            {decodeResult.outputText ?? t('a10.binaryOutput', { base64: decodeResult.outputBase64 })}
          </Text>
        </div>
      )}
      <Button disabled={busy} onClick={() => { setBusy(true); setError(''); void toolJson<FingerprintResult>(apiBase, '/api/tools/hash', { inputText }).then(setFingerprints).catch((cause: unknown) => setError(String(cause))).finally(() => setBusy(false)); }}>{t('tools.hash')}</Button>
      <Text>{t('tools.fingerprintOnly')}</Text>
      {fingerprints !== null && <div><Text block>SHA-256: {fingerprints.sha256}</Text><Text block>MD5: {fingerprints.md5}</Text></div>}
    </section>;
}
