/**
 * 探索対象の固定 fixture サイト (Playwright 対象の代替)。
 * `docs/design/19-cli-automation.md` 5章。実在の脆弱アプリではなく、
 * workflow・安全制御・証跡の検証だけを目的とする合成データ。
 * 個人情報・実秘密値・実攻撃文字列を含めない。
 */
import { hashStable, type FormDescriptor, type PageObservation } from '@scopepilot2/contracts';

export const SITE_ORIGIN = 'http://fixture.target.test';

const OUT_OF_SCOPE_LINK = 'http://elsewhere.example/out-of-scope';

const loginForm: FormDescriptor = {
  actionUrl: `${SITE_ORIGIN}/login.php`,
  method: 'POST',
  fields: [
    { name: 'username', type: 'text' },
    { name: 'password', type: 'password' },
  ],
  classification: 'login',
};

const searchForm: FormDescriptor = {
  actionUrl: `${SITE_ORIGIN}/vulnerabilities/xss_reflected/?name=guest`,
  method: 'GET',
  fields: [{ name: 'name', type: 'text' }],
  classification: 'search',
};

const filterForm: FormDescriptor = {
  actionUrl: `${SITE_ORIGIN}/vulnerabilities/sql_injection/?id=1`,
  method: 'GET',
  fields: [{ name: 'id', type: 'text' }],
  classification: 'filter',
};

interface FixturePage {
  readonly title: string;
  readonly links: readonly string[];
  readonly forms: readonly FormDescriptor[];
}

/** canonical URL を key とする固定ページ群。 */
export const FIXTURE_SITE_PAGES: Readonly<Record<string, FixturePage>> = {
  [`${SITE_ORIGIN}/`]: {
    title: 'Fixture Target Home',
    links: [
      `${SITE_ORIGIN}/login.php`,
      `${SITE_ORIGIN}/vulnerabilities/xss_reflected/?name=guest`,
      `${SITE_ORIGIN}/vulnerabilities/sql_injection/?id=1`,
      `${SITE_ORIGIN}/setup.php`,
      OUT_OF_SCOPE_LINK,
    ],
    forms: [],
  },
  [`${SITE_ORIGIN}/login.php`]: {
    title: 'Login',
    links: [`${SITE_ORIGIN}/`],
    forms: [loginForm],
  },
  [`${SITE_ORIGIN}/vulnerabilities/xss_reflected/?name=guest`]: {
    title: 'XSS Exercise (fixture)',
    links: [`${SITE_ORIGIN}/`],
    forms: [searchForm],
  },
  [`${SITE_ORIGIN}/vulnerabilities/sql_injection/?id=1`]: {
    title: 'SQLi Exercise (fixture)',
    links: [`${SITE_ORIGIN}/`],
    forms: [filterForm],
  },
  [`${SITE_ORIGIN}/setup.php`]: {
    title: 'Setup',
    links: [`${SITE_ORIGIN}/`],
    forms: [],
  },
};

export function targetSiteFixtureHash(): string {
  return hashStable('scopepilot2.simulation.target-site', {
    origin: SITE_ORIGIN,
    pages: FIXTURE_SITE_PAGES,
  });
}

/** 固定ページを PageObservation へ写す。depth・発見元は探索側の値を使う。 */
export function observeFixturePage(url: string, depth: number, discoveredFrom: string | null): PageObservation | null {
  const page = FIXTURE_SITE_PAGES[url];
  if (page === undefined) {
    return null;
  }
  return {
    url,
    status: 200,
    contentType: 'text/html; charset=utf-8',
    title: page.title,
    discoveredFrom,
    depth,
    originType: 'crawl',
    links: [...page.links],
    forms: [...page.forms],
  };
}
