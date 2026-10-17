/**
 * ExplorationPort の固定 fixture adapter。観測は fixture サイトから返し、
 * 呼出し記録を残して FT で scope 強制 (Enforced) の検証に使う。
 */
import type { PageObservation } from '@scopepilot2/contracts';
import type { ExplorationPort } from '@scopepilot2/core';
import { observeFixturePage, targetSiteFixtureHash } from '../fixtures/target-site.ts';

export class FixtureExplorer implements ExplorationPort {
  readonly engineVersion = 'fixture-playwright-1';
  private readonly observeCalls: string[] = [];

  async observe(url: string): Promise<PageObservation | null> {
    this.observeCalls.push(url);
    return observeFixturePage(url, 0, null);
  }

  calls(): readonly string[] {
    return [...this.observeCalls];
  }

  fixtureHash(): string {
    return targetSiteFixtureHash();
  }
}
