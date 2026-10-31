import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = process.cwd();
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chromePath) ? { executablePath: chromePath } : {}),
});

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  await page.goto(pathToFileURL(join(root, 'docs/guideline-conformance-evidence.html')).href);

  assert.equal(await page.title(), 'ScopePilot2 HTTP診断項目・実装確認レポート');
  assert.equal(await page.locator('.nav').evaluate((element) => getComputedStyle(element).position), 'fixed');
  assert.equal(await page.locator('.guideline-section').count(), 5);
  assert.equal(await page.locator('[data-item-row]').count(), 433);
  assert.equal(await page.locator('[data-item-row][data-http-only="true"]').count(), 433);
  assert.equal(await page.locator('[data-item-row] > td').count(), 433 * 6);
  assert.equal(await page.locator('[data-item-row] [data-code-review="complete"]').count(), 433);
  assert.equal(await page.locator('[data-item-row] .review-details li').count() >= 433, true);
  assert.equal(await page.locator('#agent-review').count(), 1);
  assert.equal(await page.locator('[data-agent-review-row]').count(), 6);
  assert.equal(await page.locator('#agent-review .status', { hasText: '要修正（High）' }).count(), 1);
  assert.equal(await page.locator('#agent-review .status', { hasText: '要改善（Medium）' }).count(), 1);
  assert.equal(await page.locator('#agent-review').getByText('npm test', { exact: false }).count() > 0, true);
  assert.equal(await page.locator('#agent-review [data-source-ref]').count() >= 15, true);
  const routeReferenceProblems = await page.locator('.routes li').evaluateAll((items) => items.flatMap((item) => {
    const route = item.querySelector('code')?.textContent ?? '';
    const references = [...item.querySelectorAll('.source-ref small')].map((small) => small.textContent ?? '');
    if (route.startsWith('workflow:') && references.some((reference) => /workflow-scan\.ts:17(?:7[1-9]|8\d|9\d)/u.test(reference))) {
      return [`${route}: registry/caller reference`];
    }
    if (route.startsWith('zap:') && references.some((reference) => !reference.includes('packages/adapters/src/zap-engine.ts:'))) {
      return [`${route}: non-adapter reference`];
    }
    if (route.startsWith('nuclei:') && references.some((reference) => !reference.includes('packages/adapters/src/nuclei-runner.ts:'))) {
      return [`${route}: non-runner reference`];
    }
    return [];
  }));
  assert.deepEqual(routeReferenceProblems, []);
  const incompleteReviews = await page.locator('[data-item-row] [data-code-review="complete"]').evaluateAll((reviews) =>
    reviews
      .filter((review) => !['実装:', '判定:', '制約:'].every((label) => (review.textContent ?? '').includes(label)))
      .map((review) => review.closest('[data-item-row]')?.querySelector('.id')?.textContent ?? ''),
  );
  assert.deepEqual(incompleteReviews, []);
  const nonHttpRows = await page.locator('[data-item-row]').evaluateAll((rows) =>
    rows
      .filter((row) => /(資料|ヒアリング|契約|実施要件・運用|スマホアプリ|TLS版|暗号スイート|証明書の信頼チェーン|サーバ証明書)/.test(row.textContent ?? ''))
      .map((row) => row.querySelector('.id')?.textContent ?? ''),
  );
  assert.deepEqual(nonHttpRows, []);
  assert.equal(await page.getByText('OWASP AISVS', { exact: false }).count(), 0);
  assert.equal(await page.getByText('OWASP CNAS', { exact: false }).count(), 0);
  assert.equal(await page.locator('.status', { hasText: 'コード経路' }).count(), 0);
  assert.equal(await page.locator('.status', { hasText: '外部エンジン' }).count(), 0);
  assert.equal(await page.getByText('ScopePilot内で自動検証', { exact: true }).count() > 0, true);
  assert.equal(await page.getByText('連携診断ツールで自動検証', { exact: true }).count() > 0, true);
  assert.equal(await page.locator('a[href^="../"]').count(), 0);

  const sourceButtons = page.locator('[data-source-ref]');
  assert.equal(await sourceButtons.count() > 433, true);
  await sourceButtons.first().click();
  assert.equal(await page.locator('#source-modal').evaluate((dialog) => dialog.open), true);
  assert.equal((await page.locator('#source-modal-content pre').textContent())?.trim().length > 0, true);
  await page.screenshot({
    path: join(process.env.TEMP ?? root, 'scopepilot2-source-popup.png'),
    fullPage: false,
  });
  await page.locator('#source-modal-close').click();
  assert.equal(await page.locator('#source-modal').evaluate((dialog) => dialog.open), false);

  const openRouteSource = async (route, buttonName) => {
    const item = page.locator('.routes li').filter({ hasText: route }).first();
    const chapter = item.locator('xpath=ancestor::details[1]');
    if (await chapter.count() > 0) await chapter.evaluate((details) => { details.open = true; });
    await item.scrollIntoViewIfNeeded();
    await item.getByRole('button', { name: buttonName }).click();
    return (await page.locator('#source-modal-content pre').textContent()) ?? '';
  };

  const workflowSource = await openRouteSource('workflow:authorization-bypass', /送信・判定を表示/u);
  assert.match(workflowSource, /runAuthorizationBypassCheck/u);
  assert.match(workflowSource, /await (?:get|post|ctx\.transport|ctx\.transport\.request)/u);
  assert.doesNotMatch(workflowSource, /LEVEL_SCOPED_CHECKS/u);
  await page.locator('#source-modal-close').click();

  const zapSource = await openRouteSource('zap:directory-listing', /診断実行を表示/u);
  assert.match(zapSource, /ascan\/action\/scan/u);
  assert.match(zapSource, /inScopeOnly: 'true'/u);
  await page.locator('#source-modal-close').click();

  const nucleiSource = await openRouteSource('nuclei:known-vulnerabilities', /診断実行を表示/u);
  assert.match(nucleiSource, /'-type', 'http'/u);
  assert.match(nucleiSource, /await this\.exec\(args/u);
  await page.locator('#source-modal-close').click();

  const theme6Source = await openRouteSource('zap-unsupported:6', /送信・判定を表示/u);
  assert.match(theme6Source, /case '6'/u);
  assert.match(theme6Source, /otp-reuse:resubmit/u);
  const scrollState = await page.locator('#source-modal-content').evaluate((element) => {
    const style = getComputedStyle(element);
    element.scrollTop = 500;
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
      overflowY: style.overflowY,
    };
  });
  assert.equal(scrollState.overflowY, 'auto');
  assert.equal(scrollState.scrollHeight > scrollState.clientHeight, true);
  assert.equal(scrollState.scrollTop > 0, true);
  await page.screenshot({
    path: join(process.env.TEMP ?? root, 'scopepilot2-long-source-popup.png'),
    fullPage: false,
  });
  await page.locator('#source-modal-close').click();

  await page.locator('.nav').getByRole('link', { name: '追加実装のレビュー' }).click();
  assert.equal(await page.evaluate(() => location.hash), '#agent-review');
  await page.locator('#agent-review').scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(process.env.TEMP ?? root, 'scopepilot2-agent-implementation-review.png'),
    fullPage: false,
  });

  await page.locator('#search').fill('WAPG-1.2-102');
  assert.equal(await page.locator('[data-item-row]:not(.hidden-by-search)').count(), 1);
  assert.equal(await page.locator('.chapter:not(.hidden-by-search)').count(), 1);

  await page.locator('#search').fill('');
  await page.locator('.nav').getByRole('link', { name: 'デジタル庁 DS-221' }).click();
  assert.equal(await page.evaluate(() => location.hash), '#g4');

  await page.screenshot({
    path: join(process.env.TEMP ?? root, 'scopepilot2-guideline-detail.png'),
    fullPage: false,
  });
  console.log('HTML browser verification OK: 433 HTTP-only rows, actual send/judge implementations, vertically scrollable source popups, fixed navigation, search, anchor navigation');
} finally {
  await browser.close();
}
