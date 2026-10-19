/**
 * LoginExecutorPort の固定 fixture adapter (design/f09 §4)。
 * fixture サイト (target-site.ts) の login.php に対して step DSL を決定的に解釈する。
 * 秘密値は実行の間だけ読み、cookie 値は合成の固定値 (service 内部でしか保持されない)。
 * 認証判定は PlaywrightLoginExecutor と同じ detectAuthState (F09-UT-002:
 * assert step が無い・marker 不一致は未認証)。
 */
import { detectAuthState, type LoginExecutionInput, type LoginExecutionResult, type LoginExecutorPort, type LoginSessionCookie } from '@scopepilot2/core';
import { FIXTURE_SITE_PAGES, SITE_ORIGIN } from '../fixtures/target-site.ts';

function resolveUrl(baseUrl: string, target: string): string {
  if (target.startsWith('http://') || target.startsWith('https://')) {
    return target;
  }
  return `${baseUrl.replace(/\/$/, '')}${target.startsWith('/') ? '' : '/'}${target}`;
}

/** fixture page の「内容」(assert の marker 検査用。title と link 先だけを合成)。 */
function pageContent(url: string): string {
  const page = FIXTURE_SITE_PAGES[url];
  if (page === undefined) {
    return '';
  }
  return [page.title, ...page.links].join('\n');
}

export class FixtureLoginExecutor implements LoginExecutorPort {
  readonly engineVersion = 'fixture-login-1';
  readonly inputs: readonly LoginExecutionInput[] = [];

  async execute(input: LoginExecutionInput): Promise<LoginExecutionResult> {
    (this.inputs as LoginExecutionInput[]).push(input);
    const variables = new Map<string, string>();
    let currentUrl = input.baseUrl;
    let filledCount = 0;
    let sawAssert = false;
    let assertResult = true;
    for (const step of input.steps) {
      switch (step.kind) {
        case 'navigate':
          currentUrl = resolveUrl(input.baseUrl, step.target ?? '');
          break;
        case 'fill': {
          const reference = step.secretReference ?? '';
          const value = variables.get(reference) ?? input.secretValues[reference];
          if (value === undefined) {
            throw new Error(`fill step could not resolve secret reference: ${reference}`);
          }
          filledCount += 1;
          break;
        }
        case 'click':
          // login.php の form は資格情報 (fill 済み) を submit すると index へ遷移する。
          if (currentUrl === `${SITE_ORIGIN}/login.php` && filledCount >= 2) {
            currentUrl = `${SITE_ORIGIN}/`;
          }
          break;
        case 'wait':
          break;
        case 'extract':
          // fixture page に入力欄は無い。変数だけ確保する (CSRF token 相当の経路確認用)。
          variables.set(step.secretReference ?? step.target ?? '', 'fixture-extracted');
          break;
        case 'assert': {
          sawAssert = true;
          const marker = step.target ?? '';
          if (marker !== '' && !pageContent(currentUrl).includes(marker)) {
            assertResult = false;
          }
          break;
        }
      }
    }
    const authenticated =
      detectAuthState({
        expectedUrlPrefix: input.expectedUrlPrefix,
        finalUrl: currentUrl,
        assertResult: sawAssert ? assertResult : false,
      }) === 'authenticated';
    const cookies: readonly LoginSessionCookie[] = authenticated
      ? [{ name: 'PHPSESSID', value: 'fixture-session', domain: new URL(input.baseUrl).host, path: '/' }]
      : [];
    return { authenticated, finalUrl: currentUrl, cookies };
  }
}
