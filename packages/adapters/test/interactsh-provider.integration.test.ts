import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InteractshCliProvider } from '../src/interactsh-provider.ts';

const serverUrl = process.env['SCOPEPILOT_OAST_SERVER_URL'];
const configPath = process.env['SCOPEPILOT_INTERACTSH_CONFIG'];
const command = process.env['SCOPEPILOT_INTERACTSH_COMMAND'];

test('self-host Interactsh が実 payload を発行する', {
  skip: serverUrl === undefined || configPath === undefined
    ? 'SCOPEPILOT_OAST_SERVER_URL / SCOPEPILOT_INTERACTSH_CONFIG 未設定'
    : false,
  timeout: 60_000,
}, async () => {
  const provider = new InteractshCliProvider({
    serverUrl: serverUrl!,
    configPath: configPath!,
    ...(command === undefined ? {} : { command }),
  });
  try {
    const result = await provider.startSession({ attemptId: 'gated-it', protocol: 'http', onEvents: () => {} });
    assert.match(result.token, /^[a-z0-9.-]+$/);
  } finally {
    await provider.close();
  }
});
