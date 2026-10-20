import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { hashStable } from '@scopepilot2/contracts';

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

  // 入力文書の hint を登録すると、以後の探索計画へ許可内 URL が統合される。
  await page.getByLabel('文書 label').fill('操作手順書 (app test)');
  await page.getByLabel('URL (1行1件)').first().fill('http://fixture.target.test/setup.php');
  await page.getByRole('button', { name: 'hint を登録する' }).click();
  await expect(page.getByText('操作手順書 (app test) の hint を登録しました (許可内 1/1 URL・以後の探索計画に統合されます)')).toBeVisible({ timeout: 30_000 });

  // 認証情報の所在 (ロール・方式・文書内の所在) も登録できる — 秘密値は持たない。
  await page.getByLabel('認証情報の role').fill('admin');
  await page.getByLabel('認証方式 (Form/Bearer/Basic/ApiKey/Cookie)').fill('Form');
  await page.getByLabel('文書内の所在 (例: p.13 管理者ログイン)').fill('p.13 管理者ログイン');
  await page.getByRole('button', { name: '認証情報の所在を登録する' }).click();
  await expect(page.getByText('操作手順書 (app test) の認証情報 hint を 1 件登録しました (A09 に未確認付きで表示されます)')).toBeVisible({ timeout: 30_000 });

  // 優先付け (pii・payment) を登録すると一致 URL を探索で先に処理する (AGENTS.md)。
  await page.getByLabel('URL 部分一致条件').fill('/login.php');
  await page.getByLabel('区分 (pii/payment)').fill('pii');
  await page.getByRole('button', { name: '優先付けを登録する' }).click();
  await expect(page.getByText('操作手順書 (app test) の優先付けを 1 件登録しました (以後の探索で先に処理されます)')).toBeVisible({ timeout: 30_000 });

  // parameter バリエーションも登録し、A07 で未確認参照として表示する (AGENTS.md)。
  await page.getByLabel('parameter 名').fill('user');
  await page.getByLabel('値 (comma 区切)').fill('admin, guest');
  await page.getByRole('button', { name: 'parameter バリエーションを登録する' }).click();
  await expect(page.getByText('操作手順書 (app test) の parameter バリエーションを 1 件登録しました (A07 に未確認付きで表示されます)')).toBeVisible({ timeout: 30_000 });

  // 上限 (ページ数) を 50 に狭めて計画を構築すると、計画表示に 50 が反映される。
  // 上限欄は探索・診断の両 section にあるため、先頭 (探索側) を指定する。
  await page.getByLabel('最大ページ数 (空=既定)').first().fill('50');
  await page.getByRole('button', { name: '探索計画を構築する' }).click();
  await expect(page.getByText(/explore: 対象 2 件・上限 \d+ req \/ 50 page/)).toBeVisible({ timeout: 30_000 });
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

  // API 仕様 (OpenAPI JSON) から対象 URL を設定できる (design/f12)。
  await page.getByLabel('API 仕様の label').fill('fixture API 仕様');
  await page.getByLabel('OpenAPI/Swagger JSON').fill("{\"openapi\": \"3.1.0\", \"servers\": [{\"url\": \"http://fixture.target.test/api\"}], \"paths\": {\"/users\": {\"get\": {}}, \"/items\": {\"get\": {}}}}");
  await page.getByRole('button', { name: 'API 仕様を取り込んで対象に設定する' }).click();
  await expect(page.getByText('API 仕様を取り込みました (endpoint 2 件→対象 2 件・除外 server 0 件・警告 0 件)')).toBeVisible({ timeout: 30_000 });

  // 取込で対象欄が上書かれたため、候補を対象に戻してから role 付き診断へ。
  await page.getByRole('button', { name: '探索結果の候補をすべて対象に設定' }).click();

  // role を指定した診断は session cookie を適用する (design/08・login は API で setup)。
  await page.evaluate(async () => {
    const base = (window as { scopepilotDesktop?: { apiBase: string } }).scopepilotDesktop?.apiBase ?? '';
    const post = async (path: string, body: unknown): Promise<void> => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${response.status}`);
      }
    };
    await post('/api/sessions/flows', {
      role: 'admin',
      flowVersion: 'f1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
        { kind: 'fill', target: '#username', secretReference: 'vault://admin-user' },
        { kind: 'fill', target: '#password', secretReference: 'vault://admin-pass' },
        { kind: 'click', target: 'input[type=submit]' },
        { kind: 'assert', target: 'Fixture Target Home' },
      ],
    });
    await post('/api/sessions/login', {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      expectedUrlPrefix: 'http://fixture.target.test/',
      secretValues: { 'vault://admin-user': 'fixture-user', 'vault://admin-pass': 'fixture-pass' },
    });
  });
  await page.getByLabel('診断 session の role (任意・A09 で login 済みの role。空なら非認証)').fill('admin');
  await page.getByRole('button', { name: '診断計画を構築する' }).click();
  await page.getByRole('button', { name: '診断計画を確認する' }).click();
  await page.getByRole('button', { name: '診断を実行する' }).click();
  await expect(page.getByText('(session cookie 適用: PHPSESSID)')).toBeVisible({ timeout: 30_000 });
});

test('A04: site map に観測一覧と scope 拒否が表示される', async () => {
  // 通信一覧の仮想化検証用に 60 件の交換を追加しておく (Repeater 送信 60 回)。
  await page.evaluate(async () => {
    const base = (window as { scopepilotDesktop?: { apiBase: string } }).scopepilotDesktop?.apiBase ?? '';
    const created = (await (await fetch(`${base}/api/repeater/drafts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetUrl: `http://fixture.target.test/traffic-seed`, protocol: 'http/1.1' }),
    })).json()) as { draft: { draftId: string; planHash: string } };
    for (let index = 0; index < 60; index += 1) {
      await fetch(`${base}/api/repeater/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draftId: created.draft.draftId, confirmedPlanHash: created.draft.planHash }),
      });
    }
  });
  await page.getByRole('button', { name: /A04 Browser \/ Site map/ }).click();
  // A08 の探索で観測済み (fixture home とその配下)。
  await expect(page.getByText(/観測済み page \(\d+ 件\)/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'http://fixture.target.test/' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'クロール' }).first()).toBeVisible();
  // A08 で登録した hint 由来の観測は「文書ヒント (未確認)」として表示される。
  await expect(page.getByRole('cell', { name: '文書ヒント (未確認)' }).first()).toBeVisible();
  // fixture home は scope 外 origin (http://elsewhere.example/out-of-scope) へ link する
  // ため、探索中に拒否記録が残る。
  // 複数回の探索で同一拒否が重複記録されうるため first を使う。
  await expect(page.getByText(/elsewhere\.example\/out-of-scope/).first()).toBeVisible();
  // HTTP history と endpoint 集約 (探索・Repeater の観測通信が記録されている)。
  await expect(page.getByText(/HTTP history \(通信 \d+ 件\)/)).toBeVisible();
  // 仮想化: 既定の窓 (50 件) を超える分は「次の 50 件を表示する」で広げる。
  const trafficLines = page.getByText(/^GET http:\/\/fixture\.target\.test\//);
  const before = await trafficLines.count();
  await expect(page.getByRole('button', { name: /次の \d+ 件を表示する/ })).toBeVisible();
  await page.getByRole('button', { name: /次の \d+ 件を表示する/ }).click();
  await expect
    .poll(async () => await trafficLines.count(), { timeout: 30_000 })
    .toBeGreaterThan(before);
  await expect(page.getByText(/GET http:\/\/fixture.target.test\/ → 200/).first()).toBeVisible();

  await expect(page.getByText(/endpoint 集約 \(\d+ 件・query は同一視\)/)).toBeVisible();
  await expect(page.getByText(/\(\d+ URL\)/).first()).toBeVisible();
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

  // extension は署名検証を通過したものだけ読み込まれる (design/f20)。
  // 署名は UI 入力欄から与える (fixture 信頼 root の規約は画面の注記どおり)。
  await page.getByLabel('extension ID').fill('app-helper');
  const manifestHash = hashStable('scopepilot2.extension.manifest', { extensionId: 'app-helper', version: '1.0.0', publisherTrusted: true, permissions: ['observations.read'], apiRange: ['scopepilot2.api.v1'] });
  await page.getByLabel('署名').fill(`trusted-app-helper-1.0.0-${manifestHash.slice(0, 8)}`);
  await page.getByRole('button', { name: 'extension を読み込む' }).click();
  await expect(page.getByText('app-helper 1.0.0 を読み込みました')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('cell', { name: 'app-helper' })).toBeVisible();

  // 証明書: CA profile の表示と信頼登録 (design/24)。
  await expect(page.getByText('scopepilot2-diagnostics — HTTPS 記録 (診断用 profile)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/fingerprint: [0-9a-f]+…/)).toBeVisible();
  await expect(page.getByText('秘密鍵の export は提供しません (design/24 §2)。')).toBeVisible();
  await expect(page.getByText('信頼登録: 未')).toBeVisible();
  await page.getByRole('button', { name: '信頼登録する' }).click();
  await expect(page.getByText('信頼登録: 済み')).toBeVisible({ timeout: 30_000 });
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

  // Sequencer: sample を収集して統計が返る (token 原文は出ない)。
  await page.getByLabel('sample 数 (30〜10000)').fill('40');
  await page.getByRole('button', { name: 'sample を収集して解析する' }).click();
  await expect(page.getByText(/結果: assessed \(sample 40・重複 0・欠落 0\)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/entropy [\d.]+ bits\/byte・出現 byte 種 \d+/)).toBeVisible();

  // 固定 token の対象は重複が増える。
  await page.getByLabel('対象 URL (scope 内)').fill('http://fixture.target.test/fixed-token');
  await page.getByRole('button', { name: 'sample を収集して解析する' }).click();
  await expect(page.getByText(/結果: assessed \(sample 40・重複 39・欠落 0\)/)).toBeVisible({ timeout: 30_000 });

  // login済みroleを指定すると対象URLに適用可能なcookieで収集する。
  await page.evaluate(async () => {
    const base = (window as { scopepilotDesktop?: { apiBase: string } }).scopepilotDesktop?.apiBase ?? '';
    const post = async (path: string, body: unknown): Promise<void> => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${response.status}`);
      }
    };
    await post('/api/sessions/flows', {
      role: 'sequencer-admin',
      flowVersion: 'f1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
        { kind: 'fill', target: '#username', secretReference: 'vault://admin-user' },
        { kind: 'fill', target: '#password', secretReference: 'vault://admin-pass' },
        { kind: 'click', target: 'input[type=submit]' },
        { kind: 'assert', target: 'Fixture Target Home' },
      ],
    });
    await post('/api/sessions/login', {
      role: 'sequencer-admin',
      baseUrl: 'http://fixture.target.test',
      expectedUrlPrefix: 'http://fixture.target.test/',
      secretValues: { 'vault://admin-user': 'fixture-user', 'vault://admin-pass': 'fixture-pass' },
    });
  });
  await page.getByLabel('収集 session の role (任意・A09 で login 済み。空なら非認証)').fill('sequencer-admin');
  await page.getByRole('button', { name: 'sample を収集して解析する' }).click();
  await expect(page.getByText('session cookie 適用: PHPSESSID')).toBeVisible({ timeout: 30_000 });

  // 応答 Set-Cookie から指定名の token を抽出でき、値そのものは表示しない。
  await page.getByLabel('token 抽出元').selectOption('cookie');
  await page.getByLabel('応答 Set-Cookie の token cookie 名').fill('SEQ_TOKEN');
  await page.getByRole('button', { name: 'sample を収集して解析する' }).click();
  await expect(page.getByText(/結果: assessed \(sample 40・重複 39・欠落 0\)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('抽出元: 応答 Set-Cookie (SEQ_TOKEN)')).toBeVisible();
  await expect(page.getByText(/sample-[a-z0-9-]+/)).toHaveCount(0);

  // 応答HTMLのhidden inputも指定field名で抽出できる。
  await page.getByLabel('token 抽出元').selectOption('hidden');
  await page.getByLabel('hidden input の token field 名').fill('csrf_token');
  await page.getByRole('button', { name: 'sample を収集して解析する' }).click();
  await expect(page.getByText(/結果: assessed \(sample 40・重複 39・欠落 0\)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('抽出元: 応答 HTML の hidden input (csrf_token)')).toBeVisible();
  await expect(page.getByText(/sample-[a-z0-9-]+/)).toHaveCount(0);

  // OAST: token を発行し、callback を記録すると相関として数えられる (design/f13)。
  await page.getByRole('button', { name: 'OAST token を発行する' }).click();
  const tokenText = page.getByText(/token: oast-[0-9a-f]+/);
  await expect(tokenText).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/attempt oast-\d+ を開始しました/)).toBeVisible();
  await page.getByRole('button', { name: 'callback を記録する (fixture)' }).click();
  await expect(page.getByText('callback 記録: 相関 1・未知 0・重複 0')).toBeVisible({ timeout: 30_000 });

  // WebSocket: frame を取り込み・送信すると台帳に残る (design/f14)。
  await page.getByLabel('取込 frame (1行1件・text)').fill('hello\nhello');
  await page.getByRole('button', { name: 'frame を取り込む' }).click();
  await expect(page.getByText('frame 取込: 1 件・重複 1 件')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('接続 session の role (任意・A09 で login 済み。空なら非認証)').fill('sequencer-admin');
  await page.getByLabel('提示 subprotocol (任意・comma 区切り、優先順)').fill('scopepilot.echo, json-v2');
  await page.getByLabel('送信 message (1行1件・text)').fill('ping');
  await page.getByRole('button', { name: 'message を送信する' }).click();
  await expect(page.getByText('送信しました (1 件・plan hash 付き)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText('handshake cookie 適用: PHPSESSID')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('cell', { name: 'ping' })).toBeVisible();

  // HTTP/2 transport: 選択と header 検証 (design/f15)。
  await page.getByRole('button', { name: 'transport を probe する' }).click();
  await expect(page.getByText('protocol h2 (downgrade なし)・ALPN h2・runtime fixture-transport')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'header を検証する' }).click();
  await expect(page.getByText(/検証 OK \(pseudo header: :method, :scheme, :authority, :path・authority: fixture\.target\.test\)/)).toBeVisible({ timeout: 30_000 });

  // DOM 調査: source→sink 候補と PII redact (design/f16)。
  const domRole = page.getByLabel('認証 role (任意・事前に login 実行済み)');
  await expect(domRole).toBeDisabled();
  await page.getByLabel('Playwright で実観測する (実 engine 構成)').check();
  await expect(domRole).toBeEnabled();
  await page.getByLabel('Playwright で実観測する (実 engine 構成)').uncheck();
  await page.getByLabel('観測 (1行1件・api: marker)').fill('location.search: q=1\ninnerHTML: q=1');
  await page.getByLabel('証跡 node (1行1件・pii: 接頭辞で redact)').fill('div content\npii: user@example.example');
  await page.getByRole('button', { name: 'value flow を分析する' }).click();
  await expect(page.getByText('候補 1 件')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/location\.search → innerHTML \(confidence 0\.9・marker q=1\)/)).toBeVisible();
  await expect(page.getByText(/\[redacted: potential PII\]/)).toBeVisible();
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

test('A06: Repeater draft を編集し表示 hash で確認送信する', async () => {
  await page.getByRole('button', { name: /A06 Repeater/ }).click();
  await page.getByRole('button', { name: '新規 draft を作る' }).click();
  // A04 test が seed 用 draft を残しているため、作成した最新 tab を明示的に選ぶ。
  await expect(page.getByRole('button', { name: /draft-\d+ \(r1\)/ })).toHaveCount(2, { timeout: 30_000 });
  await page.getByRole('button', { name: /draft-\d+ \(r1\)/ }).last().click();
  await expect(page.getByText(/draft-\d+ — http:\/\/fixture.target.test\/repeater/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/計画 hash: /)).toBeVisible();

  // header/body を編集すると revision が進み要求が組み上がる。
  await page.getByLabel(/headers \(1行1件/).fill('X-Test: 1');
  await page.getByLabel('body').fill('hello-repeater');
  await page.getByRole('button', { name: '編集を適用する' }).click();
  await expect(page.getByText(/revision 2/)).toBeVisible({ timeout: 30_000 });
  // header 値は入力欄と要求 preview の両方に出るため preview 側 (後方) を指定する。
  await expect(page.getByText(/X-Test: 1/).last()).toBeVisible();
  await expect(page.getByText(/hello-repeater/).first()).toBeVisible();

  // 表示 hash での送信は fixture 応答を返す。
  await page.getByRole('button', { name: 'この hash を確認して送信する' }).click();
  await expect(page.getByText(/送信しました \(responded\)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/fixture response for/)).toBeVisible();

  // role を指定した送信は session cookie を適用する (design/08・login は API で setup)。
  await page.evaluate(async () => {
    const base = (window as { scopepilotDesktop?: { apiBase: string } }).scopepilotDesktop?.apiBase ?? '';
    const post = async (path: string, body: unknown): Promise<void> => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) {
        throw new Error(`${path}: HTTP ${response.status}`);
      }
    };
    await post('/api/sessions/flows', {
      role: 'admin',
      flowVersion: 'f1',
      steps: [
        { kind: 'navigate', target: 'http://fixture.target.test/login.php' },
        { kind: 'fill', target: '#username', secretReference: 'vault://admin-user' },
        { kind: 'fill', target: '#password', secretReference: 'vault://admin-pass' },
        { kind: 'click', target: 'input[type=submit]' },
        { kind: 'assert', target: 'Fixture Target Home' },
      ],
    });
    await post('/api/sessions/login', {
      role: 'admin',
      baseUrl: 'http://fixture.target.test',
      expectedUrlPrefix: 'http://fixture.target.test/',
      secretValues: { 'vault://admin-user': 'fixture-user', 'vault://admin-pass': 'fixture-pass' },
    });
  });
  await page.getByLabel('送信 session の role (任意・A09 で login 済みの role。空なら非認証)').fill('admin');
  await page.getByRole('button', { name: 'この hash を確認して送信する' }).click();
  await expect(page.getByText('(session cookie 適用: PHPSESSID)')).toBeVisible({ timeout: 30_000 });
});

test('A07: payload 集合を登録し fuzz を実行して cluster 集約を見る', async () => {
  await page.getByRole('button', { name: /A07 Fuzzer/ }).click();

  // 供給元・版・license を添えて payload 集合を登録する。
  await page.getByLabel('名前').fill('xss-basic');
  await page.getByLabel('供給元 (source)').fill('fixture-handbook');
  await page.getByLabel('版').fill('1.0.0');
  await page.getByLabel('license').fill('MIT');
  await page.getByLabel(/値 \(1行1件\)/).fill('<script>1</script>\n<img src=x onerror=1>');
  await page.getByRole('button', { name: 'payload 集合を登録する' }).click();
  await expect(page.getByText(/登録済み: xss-basic \(fixture-handbook 1\.0\.0・MIT・2 件\)/)).toBeVisible({ timeout: 30_000 });

  // A08 で登録した parameter バリエーションが未確認参照として表示される。
  await expect(page.getByText('文書の記載 (未確認): user: admin, guest')).toBeVisible({ timeout: 30_000 });

  // positions を実行して cluster 集約を確認する。
  await page.getByLabel(/positions \(1行1件/).fill('user: admin, guest\nid: 1, 2');
  await page.getByRole('button', { name: 'fuzz を実行する' }).click();
  await expect(page.getByText(/組合せ 4 件中 4 件送信 → 2 cluster/)).toBeVisible({ timeout: 30_000 });
  // fixture 応答は先頭 position の値だけで決まるため、各 cluster に 2 member 集約される。
  await expect(page.getByRole('cell', { name: '2' }).first()).toBeVisible();
  await expect(page.getByRole('cell', { name: 'admin | 1' })).toBeVisible();

  // role を指定すると session cookie が適用される (design/08・A06 test の login を利用)。
  await page.getByLabel('送信 session の role (任意・A09 で login 済みの role。空なら非認証)').fill('admin');
  await page.getByRole('button', { name: 'fuzz を実行する' }).click();
  await expect(page.getByText('(session cookie 適用: PHPSESSID)')).toBeVisible({ timeout: 30_000 });
});

test('A09: login flow を登録し session refresh と cookie jar 割当を行う', async () => {
  await page.getByRole('button', { name: /A09 Sessions/ }).click();

  // A08 で登録した認証情報 hint が「文書の記載 (未確認)」として参照できる。
  await expect(page.getByText('文書の記載 (未確認・値は持たない): 操作手順書 (app test): admin は Form (p.13 管理者ログイン)')).toBeVisible({ timeout: 30_000 });

  // 既定入力のまま flow を登録する (secret は参照のみ)。
  await page.getByRole('button', { name: 'flow を登録する' }).click();
  await expect(page.getByText(/admin の flow を登録しました \(5 step/)).toBeVisible({ timeout: 30_000 });

  // login を実行する (秘密値はこの実行の間だけ API へ渡り、実行後は入力欄が空に戻る)。
  await page.getByLabel('秘密値: vault://admin-user').fill('fixture-user');
  await page.getByLabel('秘密値: vault://admin-pass').fill('fixture-pass');
  await page.getByRole('button', { name: 'login を実行する' }).click();
  await expect(page.getByText('admin の login: 認証済み (最終 URL http://fixture.target.test/・cookie PHPSESSID)')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('秘密値: vault://admin-user')).toHaveValue('');

  // 認証付き探索 (design/f09): A08 で role を指定すると認証後のみ見える頁が観測できる。
  // menu.php は link を持たないが、A08 test で登録した hint (setup.php) が home へ
  // link するため観測は 6 件 (menu・setup・home・login・xss・sqli)・候補 9 (form 3 含む)。
  await page.getByRole('button', { name: /A08 Scan plans/ }).click();
  await page.getByLabel('開始 URL (1行1件)').fill('http://fixture.target.test/authenticated/menu.php');
  await page.getByLabel('探索 session の role (任意・A09 で login 済みの role。空なら非認証)').fill('admin');
  await page.getByRole('button', { name: '探索計画を構築する' }).click();
  await page.getByRole('button', { name: '探索計画を確認する' }).click();
  await page.getByRole('button', { name: '探索を実行する' }).click();
  await expect(page.getByText('探索完了: 観測 6 件・候補 9 件・scope 外拒否 1 件')).toBeVisible({ timeout: 30_000 });

  // A09 に戻して session 系の操作を続ける。
  await page.getByRole('button', { name: /A09 Sessions/ }).click();

  // cookie jar を割り当て、session を refresh すると revision が進む。
  await page.getByRole('button', { name: 'cookie jar を割り当てる' }).click();
  await expect(page.getByText(/admin に cookie jar を割り当てました/)).toBeVisible({ timeout: 30_000 });
  const adminSessionRow = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: 'admin', exact: true }),
  });
  await adminSessionRow.getByRole('button', { name: 'refresh' }).click();
  await expect(page.getByText(/session を更新しました \(revision 1\)/)).toBeVisible({ timeout: 30_000 });
  await expect(adminSessionRow.getByRole('cell', { name: 'PHPSESSID' })).toBeVisible();

  // guest flow も登録して両 role の session を揃える。
  await page.getByLabel('role').first().fill('guest');
  await page.getByRole('button', { name: 'flow を登録する' }).click();
  await expect(page.getByText(/guest の flow を登録しました/)).toBeVisible({ timeout: 30_000 });
  const guestSessionRow = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: 'guest', exact: true }),
  });
  await guestSessionRow.getByRole('button', { name: 'refresh' }).click();
  await expect(page.getByText(/guest の session を更新しました/)).toBeVisible({ timeout: 30_000 });

  // CrossRoleTest を許可する認可に付替え、業務ロジック検証 (role 差分) を実行する。
  await page.evaluate(async () => {
    const base = (window as { scopepilotDesktop?: { apiBase: string } }).scopepilotDesktop?.apiBase ?? '';
    await fetch(`${base}/api/authorization`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        allowedOperationClasses: ['Browse', 'ActiveScan', 'CrossRoleTest'],
        targetRoles: ['admin', 'guest'],
        validFrom: '2026-10-18T00:00:00.000Z',
        validUntil: '2026-10-19T00:00:00.000Z',
        evidenceLabel: '認可 (デスクトップ)',
        evidenceContent: 'cross-role evidence',
      }),
    });
  });
  await page.getByRole('button', { name: '業務ロジック検証を実行する' }).click();
  await expect(page.getByText(/結果: pass \(比較 pass・restore restored・証拠分離 あり\)/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/観測: admin=business-response:admin・guest=business-response:guest/)).toBeVisible();
});

test('言語を ja/en で切り替えられる (design/28 §8.1)', async () => {
  // 既定は ja。トグルで en になり、主要ラベルが英語表記に切り替わる。
  await expect(page.getByRole('button', { name: 'アドバンスド' })).toBeVisible();
  await page.getByRole('button', { name: /言語 \/ Language/ }).click();
  await expect(page.getByRole('button', { name: 'Advanced', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Simple', exact: true })).toBeVisible();
  // 戻すと ja に戻る (以後の test は ja 前提)。
  await page.getByRole('button', { name: /言語 \/ Language/ }).click();
  await expect(page.getByRole('button', { name: 'アドバンスド' })).toBeVisible();
});

test('キーボードだけでモードと画面ナビを操作できる (design/02 §6)', async () => {
  // Simple へ戻し、モード切替を keyboard だけで行う。
  await page.getByRole('button', { name: 'シンプル' }).click();
  await expect(page.getByText('S01 案件を開く').first()).toBeVisible();
  const advancedButton = page.getByRole('button', { name: 'アドバンスド' });
  await advancedButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('navigation', { name: 'Advanced 画面ナビ' })).toBeVisible();

  // ナビも keyboard で画面切替できる。
  const a02 = page.getByRole('button', { name: /A02 Scope & Authorization/ });
  await a02.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Scope \(現在 revision \d+\)/)).toBeVisible();
});

test('OS の明暗設定にテーマが追従する (design/28 §8.1 MUST 3)', async () => {
  const providerColor = async (): Promise<string> =>
    page.evaluate(() => {
      const provider = document.querySelector('.fui-FluentProvider');
      return provider === null ? '' : getComputedStyle(provider).backgroundColor;
    });
  const light = await providerColor();
  // dark へ切替 (Electron の renderer は emulateMedia で prefers-color-scheme を切替可)。
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(async () => await providerColor(), { timeout: 10_000 })
    .not.toBe(light);
  // 元に戻す (以後の test は light 前提ではないが、状態を残さない)。
  await page.emulateMedia({ colorScheme: 'light' });
  await expect
    .poll(async () => await providerColor(), { timeout: 10_000 })
    .toBe(light);
});

test('未実装プレースホルダはもう残っていない (全 Advanced 画面が実装済み)', async () => {
  await expect(page.getByText('この画面は未実装です (後続増分で提供します)。')).toHaveCount(0);
});
