/**
 * ExplorationPort の固定 fixture adapter。観測は fixture サイトから返し、
 * 呼出し記録を残して FT で scope 強制 (Enforced) の検証に使う。
 * observeWithSession は認証済み session (design/f09) の経路 — cookie を記録して
 * 同じ fixture page を観測する (session でしか見えない頁の模擬はしない)。
 */
import type { PageObservation } from '@scopepilot2/contracts';
import type { ExplorationPort, LoginSessionCookie } from '@scopepilot2/core';
import { observeFixturePage, targetSiteFixtureHash } from '../fixtures/target-site.ts';

export class FixtureExplorer implements ExplorationPort {
  readonly engineVersion = 'fixture-playwright-1';
  private readonly observeCalls: string[] = [];
  private readonly sessionObservations: { readonly url: string; readonly cookieNames: readonly string[] }[] = [];

  async observe(url: string): Promise<PageObservation | null> {
    this.observeCalls.push(url);
    return observeFixturePage(url, 0, null);
  }

  async observeWithSession(
    url: string,
    session: { readonly cookies: readonly LoginSessionCookie[] },
  ): Promise<PageObservation | null> {
    this.sessionObservations.push({ url, cookieNames: session.cookies.map((cookie) => cookie.name) });
    return observeFixturePage(url, 0, null);
  }

  calls(): readonly string[] {
    return [...this.observeCalls];
  }

  sessionCalls(): readonly { readonly url: string; readonly cookieNames: readonly string[] }[] {
    return [...this.sessionObservations];
  }

  fixtureHash(): string {
    return targetSiteFixtureHash();
  }
}
