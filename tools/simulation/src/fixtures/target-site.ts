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

/**
 * 認証後のみ観測できる頁 (design/f09 の role session 探索の実証用)。
 * 通常頁からは link しない — 非 session 探索では観測が null になり、
 * seed を与えた role session 探索でのみ現れる (DVWA の認証後 menu 相当)。
 */
export const FIXTURE_AUTHENTICATED_PAGES: Readonly<Record<string, FixturePage>> = {
  [`${SITE_ORIGIN}/authenticated/menu.php`]: {
    title: 'Authenticated Menu (fixture)',
    links: [],
    forms: [],
  },
};

export function targetSiteFixtureHash(): string {
  return hashStable('scopepilot2.simulation.target-site', {
    origin: SITE_ORIGIN,
    pages: FIXTURE_SITE_PAGES,
    authenticatedPages: FIXTURE_AUTHENTICATED_PAGES,
  });
}

/** 固定ページを PageObservation へ写す。depth・発見元は探索側の値を使う。 */
export function observeFixturePage(url: string, depth: number, discoveredFrom: string | null): PageObservation | null {
  return toObservation(FIXTURE_SITE_PAGES[url], url, depth, discoveredFrom);
}

/**
 * 認証済み session での観測。認証後しか見えない頁 (public page からは link されて
 * いない = seed でのみ到達) を先に引き、次に通常頁を引く。
 */
export function observeAuthenticatedFixturePage(url: string, depth: number, discoveredFrom: string | null): PageObservation | null {
  return toObservation(FIXTURE_AUTHENTICATED_PAGES[url] ?? FIXTURE_SITE_PAGES[url], url, depth, discoveredFrom);
}

function toObservation(
  page: FixturePage | undefined,
  url: string,
  depth: number,
  discoveredFrom: string | null,
): PageObservation | null {
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
