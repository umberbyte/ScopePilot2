import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

/**
 * Advanced モードの実 DOM 検証。`docs/detailed-design/02-ui-information-architecture.md` §3。
 * A01〜A13 ナビ・A01 Dashboard (案件・能力表・Interrupted 検出)・A12 監査 event を確認する。
 */
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({ args: ['dist/main.cjs'] });
  page = await app.firstWindow();
  await expect(page).toHaveTitle(/ScopePilot2/);
  await page.getByRole('button', { name: 'アドバンスド' }).click();
});

test.afterAll(async () => {
  await app.close();
});

test('A01〜A13 のナビが表示され、A01 が既定の着地画面', async () => {
  const nav = page.getByRole('navigation', { name: 'Advanced 画面ナビ' });
  await expect(nav).toBeVisible();
  await expect(nav.getByRole('button')).toHaveCount(13);
  await expect(page.getByText('A13 Settings / Certificates / Engines / AI')).toBeVisible();
  await expect(page.getByText('外部 engine 能力 (保証等級)')).toBeVisible();
});

test('A01: 案件を作成すると案件情報と能力表 (保証等級) が表示される', async () => {
  await page.getByRole('button', { name: '案件を作成する' }).click();
  await expect(page.getByText(/案件「ScopePilot2 案件」/)).toBeVisible({ timeout: 30_000 });
  // 能力表は fixture 由来であることと保証等級を行で開示する。
  // 能力表の由来列は engine 行ごとに出る (3 engine)。
  await expect(page.getByRole('cell', { name: 'fixture (実測ではない)' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Delegated' }).first()).toBeVisible();
  // run 永続化 (SQLite) 接続後の Interrupted 検出。通常終了なら「なし」。
  await expect(page.getByText(/検出されませんでした/)).toBeVisible();
});

test('A12: 監査 event に案件作成が記録されている', async () => {
  await page.getByRole('button', { name: /A12 Jobs \/ Evidence \/ Audit/ }).click();
  await expect(page.getByText(/監査 event \(\d+ 件\)/)).toBeVisible();
  await expect(page.getByText(/CaseCreated/)).toBeVisible();
});

test('A02: scope を編集して保存し、競合時は再読込を案内する', async () => {
  await page.getByRole('button', { name: /A02 Scope & Authorization/ }).click();
  // 認可は A01 の案件作成で付与済み。有効期間と許可操作を表示する。
  await expect(page.getByText(/認可: 付与済み/)).toBeVisible();
  await expect(page.getByText(/Browse, ActiveScan/)).toBeVisible();

  // 禁止 Origin を追加して保存 → revision が進む (許可 Origin はそのまま)。
  const denied = page.getByLabel('禁止 Origin (1行1件)');
  await denied.fill('http://denied.fixture.target.test');
  await page.getByRole('button', { name: 'scope を保存する' }).click();
  await expect(page.getByText(/revision 2 で保存しました/)).toBeVisible({ timeout: 30_000 });

  // 別 window による更新を擬似する (page 内から直接 scope を更新して revision 3 へ)。
  await page.evaluate(async () => {
    const base = (window as { scopepilotDesktop?: { apiBase: string } }).scopepilotDesktop?.apiBase ?? '';
    const current = (await (await fetch(`${base}/api/case`)).json()) as {
      revision: number;
      scope: { allowedOrigins: readonly string[]; deniedOrigins: readonly string[]; limits: { maxRequests: number; maxPages: number; maxDurationMinutes: number } };
    };
    await fetch(`${base}/api/case/scope`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedRevision: current.revision,
        allowedOrigins: current.scope.allowedOrigins,
        deniedOrigins: current.scope.deniedOrigins,
        limits: { maxRequests: current.scope.limits.maxRequests - 1, maxPages: current.scope.limits.maxPages, maxDurationMinutes: current.scope.limits.maxDurationMinutes },
      }),
    });
  });
  // 画面の保持 revision (2) で保存しようとすると 409 → 競合表示、自動上書きしない。
  await page.getByRole('button', { name: 'scope を保存する' }).click();
  await expect(page.getByText(/自動上書きは行いません/)).toBeVisible({ timeout: 30_000 });
  // 再読込で最新 revision (3) を取り込める。
  await page.getByRole('button', { name: '再読込' }).click();
  await expect(page.getByText(/Scope \(現在 revision 3\)/)).toBeVisible({ timeout: 30_000 });
});

test('A11: 所見一覧から確定/棄却でき、報告書を生成できる', async () => {
  // 探索→採用→診断 (S03〜S06 と同じ API 連鎖) を実行して所見を作る。
  // engine は探索で観測済みの URL しか診断できない (URL Does not Exist 回避) ため、
  // 探索から実行する。
  await page.evaluate(async () => {
    const base = (window as { scopepilotDesktop?: { apiBase: string } }).scopepilotDesktop?.apiBase ?? '';
    const post = async <T>(path: string, body: unknown): Promise<T> => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
      }
      return (await response.json()) as T;
    };
    const explore = await post<{ plan: unknown }>('/api/plan/explore', { seeds: ['http://fixture.target.test/'] });
    const exploreConfirmation = await post<{ confirmationId: string }>('/api/plan/confirm', { plan: explore.plan });
    const exploreRun = await post<{ candidates: readonly { candidateId: string; url: string; method: string; category: string; guidelineBasis: readonly string[]; confidence: number; observationUrl: string }[] }>('/api/run/explore', {
      plan: explore.plan,
      confirmation: exploreConfirmation,
      maxDepth: 5,
    });
    const adopted = await post<{ adopted: readonly unknown[] }>('/api/candidates/adopt', { candidates: exploreRun.candidates });
    void adopted;
    const targets = exploreRun.candidates.map((candidate) => candidate.url);
    const scan = await post<{ plan: unknown }>('/api/plan/scan', { targets });
    const scanConfirmation = await post<{ confirmationId: string }>('/api/plan/confirm', { plan: scan.plan });
    await post('/api/run/scan', { plan: scan.plan, confirmation: scanConfirmation, adopted: exploreRun.candidates });
  });
  await page.getByRole('button', { name: /A11 Findings \/ Organizer \/ Report/ }).click();
  await expect(page.getByText(/所見 \(\d+ 件\)/)).toBeVisible();
  // engine 由来の所見は実影響未確認ラベルと候補状態で出る。
  await expect(page.getByText(/\[実影響未確認\]/).first()).toBeVisible();
  await expect(page.getByText('候補 (未確認)').first()).toBeVisible();

  // 先頭行を確定するとその行の状態が変わる (他の候補はそのまま)。
  const firstRow = page.getByRole('row', { name: /実影響未確認/ }).first();
  await firstRow.getByRole('button', { name: '確定' }).click();
  await expect(firstRow.getByText('確定済み')).toBeVisible({ timeout: 30_000 });

  // 報告書を生成できる (限界開示を含む markdown)。
  await page.getByRole('button', { name: '報告書を生成する' }).click();
  await expect(page.getByText(/診断報告書/)).toBeVisible({ timeout: 30_000 });
});

test('A08: 上限を狭めた探索計画を構築・確認・実行し、診断まで実行できる', async () => {
  await page.getByRole('button', { name: /A08 Scan plans/ }).click();

  // 上限 (ページ数) を 50 に狭めて計画を構築すると、計画表示に 50 が反映される。
  // 上限欄は探索・診断の両 section にあるため、先頭 (探索側) を指定する。
  await page.getByLabel('最大ページ数 (空=既定)').first().fill('50');
  await page.getByRole('button', { name: '探索計画を構築する' }).click();
  await expect(page.getByText(/50 page/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/計画 hash: /)).toBeVisible();

  await page.getByRole('button', { name: '探索計画を確認する' }).click();
  await expect(page.getByText(/確認 ID: /)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '探索を実行する' }).click();
  await expect(page.getByText(/探索完了: 観測 \d+ 件・候補 \d+ 件/)).toBeVisible({ timeout: 30_000 });

  // 探索候補を対象に診断計画を構築・確認・実行する。
  await page.getByRole('button', { name: '探索結果の候補をすべて対象に設定' }).click();
  await page.getByRole('button', { name: '診断計画を構築する' }).click();
  await expect(page.getByText(/active-scan: 対象 \d+ 件/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '診断計画を確認する' }).click();
  await page.getByRole('button', { name: '診断を実行する' }).click();
  await expect(page.getByText(/診断完了 \(engine/)).toBeVisible({ timeout: 30_000 });
});

test('A04: site map に観測一覧と scope 拒否が表示される', async () => {
  await page.getByRole('button', { name: /A04 Browser \/ Site map/ }).click();
  // A08 の探索で観測済み (fixture home とその配下)。
  await expect(page.getByText(/観測済み page \(\d+ 件\)/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'http://fixture.target.test/' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'クロール' }).first()).toBeVisible();
  // fixture home は scope 外 origin (http://elsewhere.example/out-of-scope) へ link する
  // ため、探索中に拒否記録が残る。
  // 複数回の探索で同一拒否が重複記録されうるため first を使う。
  await expect(page.getByText(/elsewhere\.example\/out-of-scope/).first()).toBeVisible();
  await expect(page.getByText('HTTP history (通信一覧・仮想化表示) は後続増分で提供します。')).toBeVisible();
});

test('A03: catalog の診断項目をガイドライン切替・絞り込み・詳細表示できる', async () => {
  await page.getByRole('button', { name: /A03 Guidelines & Check Catalog/ }).click();
  // 成果物の計数と由来 (catalog hash・元資料) が見える。
  await expect(page.getByText(/診断項目 769・ZAP rule 102・ZAP 非対応 theme 92/)).toBeVisible();
  await expect(page.getByText(/catalog hash: /)).toBeVisible();

  // ガイドラインを切り替えると表示項目が変わる。
  await page.getByRole('button', { name: 'OWASP WSTG 4.2' }).click();
  await expect(page.getByText(/件 \(全 \d+ 件中\)/)).toBeVisible();

  // 絞り込み→詳細で検証方法が出る。
  await page.getByPlaceholder('絞り込み (項目名・要求・章)').fill('セッション');
  await page.getByRole('button', { name: '開く' }).first().click();
  await expect(page.getByText(/検証方法: /).first()).toBeVisible();

  // ZAP ルール tab も切替できる。
  await page.getByRole('button', { name: 'ZAP 診断ルール' }).click();
  await expect(page.getByText(/ZAP 診断ルール: \d+ 件/)).toBeVisible();
});

test('A13: engine 能力の詳細 (overshoot・測定時刻・fixture hash) と現状開示を表示する', async () => {
  await page.getByRole('button', { name: /A13 Settings \/ Certificates/ }).click();
  await expect(page.getByText(/保証等級 — Enforced: /)).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'overshoot 上限比' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '5%' }).first()).toBeVisible();
  await expect(page.getByRole('columnheader', { name: 'fixture hash' })).toBeVisible();
  // 証明書と AI は「未提供・未設定」を偽りなく表示する。
  await expect(page.getByText(/後続増分で提供します \(design\/24\)/)).toBeVisible();
  await expect(page.getByText(/AI provider は未設定です/)).toBeVisible();
});

test('A10: codec chain 復号とテキスト比較 (provenance 付き) ができる', async () => {
  await page.getByRole('button', { name: /A10 Decoder \/ Comparer/ }).click();

  // base64 → url の chain 復号。
  await page.getByLabel('入力 (text)').fill('SGVsbG8lMjAlMjZQaWxvdCE=');
  await page.getByRole('button', { name: 'base64 を追加' }).click();
  await page.getByRole('button', { name: 'url を追加' }).click();
  await expect(page.getByText('chain: base64 → url')).toBeVisible();
  await page.getByRole('button', { name: '復号する' }).click();
  // base64 → url chain の結果は 'Hello &Pilot!' (base64 が %26 まで戻し、url が残りを戻す)。
  await expect(page.getByText(/Hello &Pilot!/)).toBeVisible();

  // テキスト比較: 1 行差分と provenance hash。
  await page.getByLabel('左').fill('same\nfirst');
  await page.getByLabel('右').fill('same\nsecond');
  await page.getByRole('button', { name: '比較する' }).click();
  await expect(page.getByText(/差分 1 行/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('cell', { name: 'first' })).toBeVisible();
  await expect(page.getByText(/provenance: /)).toBeVisible();

  // Sequencer は後続増分である旨の明示。
  await expect(page.getByText(/乱数性解析は sample 収集機能と共に後続増分/)).toBeVisible();
});

test('A05: break queue の受付・転送・破棄と対象外 URL の拒否を扱う', async () => {
  await page.getByRole('button', { name: /A05 Proxy \/ Intercept/ }).click();
  await expect(page.getByText(/break queue \(0 件・保持中 0 件\)/)).toBeVisible();

  // 対象内 URL へ転送すると Forwarded になる。
  await page.getByLabel(/messageReference/).fill('a05-first');
  await page.getByRole('button', { name: '受け取る (fixture 受付)' }).click();
  await expect(page.getByText(/break queue \(1 件・保持中 1 件\)/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: '転送' }).click();
  await expect(page.getByText(/を転送しました/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('転送済み').first()).toBeVisible();

  // 対象外 URL への転送は拒否され、item は保持されたまま。
  await page.getByLabel(/messageReference/).fill('a05-second');
  await page.getByRole('button', { name: '受け取る (fixture 受付)' }).click();
  await page.getByLabel(/転送先 URL/).fill('http://elsewhere.example/');
  await page.getByRole('button', { name: '転送' }).click();
  await expect(page.getByText(/転送を拒否されました/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/保持中 1 件/)).toBeVisible();

  // 保持中 item は破棄できる (暗黙転送しない)。
  await page.getByRole('button', { name: '破棄' }).click();
  await expect(page.getByText(/を破棄しました/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/保持中 0 件/)).toBeVisible();
});

test('未実装画面はプレースホルダで明示される (A06)', async () => {
  await page.getByRole('button', { name: /A06 Repeater/ }).click();
  await expect(page.getByText('この画面は未実装です (後続増分で提供します)。')).toBeVisible();
});
