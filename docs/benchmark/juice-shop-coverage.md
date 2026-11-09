# Juice Shop カバレッジ表 (v0.1)

測定対象・条件・各評価段階の定義と、2026-11-05 時点の実測値を示す。
本表は明示されたベンチマーク依頼 (2026-11-02) に基づく測定記録であり、
一般化実装に Juice Shop 固有の知識は含まない。

> **2026-11-05 レビュー訂正:** 従来の「103/103 到達」「66/103 診断適用可能」は、
> 粗い challenge→経路対応と候補トラックの交差を、実能力として強く表現しすぎていた。
> 正しくは「関連表面を観測 103 件相当」「診断トラック候補あり 66 件相当」という参考値であり、
> challenge の到達・診断実行・検出・解決を証明しない。ScopePilot の診断による新規 challenge
> 解決確認は 0 件、製品所見として確認できた SQL injection は 2 経路である。

## 評価段階の定義

| 段階 | 定義 | 判定根拠 |
|---|---|---|
| 関連表面を観測 (参考値) | 粗く対応付けた画面ルートまたは API のいずれかが探索観測に存在する | 探索観測 (URL・観測リクエスト) |
| 診断トラック候補あり (参考値) | 対応付けた探索候補に診断トラック名が付いている | 候補 (ScanCandidate) と診断トラック。実行可能性は別途検証が必要 |
| challenge 解決確認済み | ScopePilot の診断を実行し、新規 challenge 解決を確認した | 診断前後の `/api/Challenges` の solved 差分と所見証拠 |

## 測定条件

- Juice Shop v20.3.0 (image digest `sha256:cea5a4af...`, 公開範囲 127.0.0.1 のみ)
- 追加確認: 公式 commit `717f5efa886b0417eeecb52378b03cf10567b7e2` を WSL/Linux arm64・
  Node.js v24.21.0・非Dockerでビルドし、`127.0.0.1:53188` のみで起動。Docker無効指定18件に
  対して Linux 無効指定は0件。外部APIを要するWeb3/LLM challengeは別途依存サービスが必要。
- ScopePilot2: 2026-11-05 実装 (SPA 静的ルート抽出 + storage 認証継承 + 動的ルート具体化)
- 深さ 2、上限 maxPages 300 / maxRequests 500、単一 Chromium、Cookie・localStorage・sessionStorage 継承
- 実測ハーネス: `packages/adapters/test/juice-shop-crawl-measure.ts` (環境変数で対象・資格情報を指定)

## 実測サマリ

| 項目 | 未認証 (2026-11-05 朝) | user (customer) | admin |
|---|---|---|---|
| 訪問 URL (一意) | 57 | 300 (上限到達) | 300 (上限到達) |
| 失敗 (HTTP 4xx 以上) | 0 | 0 | 0 |
| 観測 API 経路 (種) | 10 | 69 | 69 |
| ルートテンプレート (種) | - | 5 | 5 |
| 動的ルート具体化 (訪問) | - | 45 | 45 |
| 所要時間 | - | 419.8 秒 | 417.4 秒 |

2026-11-05の非Docker・クリーン環境 (116件すべて未解決から開始) でも user ロールを再実測し、
414.0秒、訪問300、HTTP 4xx以上0、API経路形状69種、動的ルート具体化45件、候補266件だった。
これは探索量の再現確認であり、challenge到達数・検出数ではない。

### 観測されたルートテンプレート (全ロール共通)

- `address/edit/:addressId`
- `coding-challenge/:challengeKey`
- `conversation/:id`
- `order-completion/:id`
- `payment/:entity`

いずれもテンプレート自体は巡回せず、観測済み識別子 (API 応答・リクエスト URL の数値/UUID) のみで具体化した。

### 具体化の実例 (user ロール)

- `address/edit/25` `address/edit/75` `address/edit/1` ... (観測された住所 ID)
- `order-completion/25` `order-completion/75` ... (観測された注文 ID)
- `payment/25` `payment/75` ... (観測された ID で具体化)

### 認証後のみ観測された主な経路 (user / admin)

- 画面 (両ロールで巡回を確認。`administration`・`accounting` は画面ルート自体は到達するが、API 応答はロールで変化する):
  `address/*`, `basket`, `order-summary`, `order-history`, `order-completion/*`, `payment/*`, `chatbot`, `conversation/*`, `privacy-security/*`, `change-password`, `two-factor-authentication`, `data-export`, `last-login-ip`, `deluxe-membership`, `saved-payment-methods`, `delivery-method`, `wallet`, `wallet-web3`, `web3-sandbox`, `track-result/*`, `recycle`, `complain`, `contact`, `photo-wall`, `about`, `juicy-nft`, `bee-haven`, `score-board`, `accounting`, `administration`
- API: `/rest/basket/{id}`, `/rest/user/whoami` (認証付き), `/api/Quantitys/{id}`, `address`・`conversation` 関連

## challenge インベントリと現状

v20.3.0 既定構成で 116 challenge。カテゴリ別:

| カテゴリ | 件数 | 関連表面を観測 (粗い推定) | トラック候補あり (粗い推定) | ScopePilot 診断で新規解決確認 |
|---|---|---|---|---|
| Sensitive Data Exposure | 17 | 14 (+3 client-side) | 9/14 | 0 |
| Injection | 14 | 14 | 10/14 | 0 |
| Improper Input Validation | 12 | 12 | 8/12 | 0 |
| Broken Access Control | 12 | 12 | 9/12 | 0 |
| XSS | 9 | 9 | 4/9 | 0 |
| Vulnerable Components | 9 | 2 (+7 client-side) | 1/2 | 0 |
| Broken Authentication | 9 | 9 | 8/9 | 0 |
| Miscellaneous | 6 | 5 (+1 client-side) | 3/5 | 0 |
| Security Misconfiguration | 5 | 5 | 4/5 | 0 |
| Cryptographic Issues | 5 | 4 (+1 client-side) | 0/4 | 0 |
| Observability Failures | 4 | 4 | 3/4 | 0 |
| Broken Anti Automation | 4 | 4 | 3/4 | 0 |
| Security through Obscurity | 3 | 2 (+1 client-side) | 1/2 | 0 |
| Insecure Deserialization | 3 | 3 | 1/3 | 0 |
| Unvalidated Redirects | 2 | 2 | 0/2 | 0 |
| XXE | 2 | 2 | 2/2 | 0 |
| 計 | 116 | 103 件相当 (粗い機械推定) + 13 client-side | 66/103 件相当 (トラック名の付与) | 0 |

別指標として、ZAP が SQL injection の high 所見を `/rest/products/search` と `POST /rest/user/login`
の 2 経路で報告した。ただし、これは challenge の新規解決確認ではない。

「診断トラック候補あり」は機械集計 (2026-11-05): challenge 関連経路に一致する探索候補が診断トラック
(zap-active / api-schema 等) を持つか。判定表: `docs/benchmark/juice-shop-challenge-diagnosability.md`
(ツール `judge-challenge-diagnosability.py`、観測ダンプ付きクロール実測との交差)。

2026-11-05 深夜の製品改善 (スクリプト内 API 呼び出し定義の抽出・トランスポート経路の候補化除外・
候補の横断重複排除) により、**トラック候補ありは 50 → 66/103 件相当** に増加 (zap-active 40・api-schema 39・
authorization-differential 1)。書き込み API (`POST /api/BasketItems`・`POST /rest/user/login`・
`POST /rest/user/reset-password` 等) がフロントエンド bundle の定義から候補化されるようになった。
候補総数は重複排除により 24,963 → 266 件に整理。

### 「候補化されていない」37 件の残ギャップ (2026-11-05 機械判定)

1. **リンクされない隠蔽経路** (easter egg・premium paywall 等): 探索で発見できない。
   → 必要な能力: 辞書的な経路発見 (対象の許可内・予算内) または入力文書からの hint。
2. **client 側で組み立てる経路** (clock 操作・負の注文等): サーバ側固定経路を持たない。
   → 必要な能力: 対話実行 (workflow テンプレート) による観測。
3. **静的素材・暗号素材** (Cryptographic Issues 0/4): 巡回対象化されていない。
   → 必要な能力: 公開静的資産 (鍵ファイル等) の候補化と cryptography-review トラック接続
   (`docs/design/30` 30.4)。
4. **一部の複合パス構築** (`/rest/products/reviews` 等の基底+suffix 結合): スクリプト解析の
   基底ペアリングで部分的に取りこぼし。→ 抽出規則の精密化が今後課題。

「関連表面を観測」は粗い機械推定 (2026-11-05): challenge のサーバ側解決位置 (`solveIf` 呼び出し) ×
ルート定義から導出した対象経路が、ロール別クロール実測 (user/admin) の観測と交差したか。
導出・判定ツールとチャレンジ単位の対応表: `docs/benchmark/derive-challenge-routes.py`、
`docs/benchmark/judge-challenge-reach.py`、`docs/benchmark/juice-shop-challenge-routes.md`。
チャレンジと対象経路の対応は Juice Shop 側の実装知識であり、判定表は本表でのみ管理する。
同じファイル内の複数の `solveIf` とルートが広く関連付く場合があるため、この数値を challenge
到達数として扱わない。challenge 解決確認と製品所見は別指標として記録する。

### client-side challenge (機械判定対象外 13 件) と必要な能力

| challenge | 必要な能力 |
|---|---|
| Forged Signed JWT / Unsigned JWT | JWT 検証解読 (鍵・署名アルゴリズム検査。静的解析+暗号検査トラック) |
| Frontend Typosquatting / Legacy Typosquatting / Supply Chain Attack | フロントエンド依存の静的解析 (bundle 中の依存名・版の照合) |
| Vulnerable Library / Vulnerable Infrastructure / Security Advisory / Weird Crypto | コンポーネント脆弱性データベース照合 (Nuclei/CSAF 系) |
| Leaked Unsafe Product / Leaked API Key / Login Cloud Admin | 機密情報漏洩検知 (公開面の走査・既知漏洩パターン。OAST/静的) |
| Steganography | 画像解析 (人手または専用検査) |

## 診断実行の実測 (2026-11-05 夜)

### 汎用 HTTP 診断 (ZAP 不要・ScopePilot 自己完結)

対象: 主要公開経路 (home・login・contact・search の画面と API 5 経路)。

- workflow scan 9 チェック: 1 所見 (security-headers: CSP・Referrer-Policy 不足)、14 リクエスト
- ZAP 非対応テーマ 24 (追加ヘッダー) / 25 (HTTP メソッド): inconclusive、テーマ 30 (公開面): denied (27 probe)
- challenge 新規解決: 0

### ZAP 能動診断 (製品構成どおり: 探索→候補→ZAP→取込)

構成: `composeEngines` (ZAP 2.17.0 daemon 自前起動・探索は ZAP proxy 経由・深さ 2)。
未認証: 探索 60 ページ・候補 452・採用 40 対象・active scan (Medium) 約 70 秒・2 回実行で
いずれも Completed (取込所見 151 → 166)。admin (認証付き): 探索 30 ページ・候補 362・
採用 40 対象 (ポーリング/静的アセットを測定側で除外)・32 秒で Completed (所見 68)。

- **検出確認済み (製品としての脆弱性検出)**:
  - SQL インジェクション (high) @ `GET /rest/products/search?q=` (未認証・admin 両方)
  - SQL インジェクション (high) @ `POST /rest/user/login` (admin 実行。後述の login 候補化による)
- その他の所見: CSP 未設定・クロスドメイン設定 (受動系・URL 単位)、URL リライト内セッション ID
  (socket.io sid) など。
- challenge 新規解決: 0 (challenge の自動解決には payload 実行による /solve 呼び出しまで必要で、
  反射ベースの検出とは段階が異なる。下記「必要な能力」参照)

### login 実行時の観測から認証 API を候補化 (2026-11-05 実装)

SPA の XHR 裏付け認証 (POST /rest/user/login) は探索では観測できない。login 実行時の
リクエスト観測 (入力点の名前のみ。値・第三者 Origin は含まない) を診断候補へ合成する
ようにした結果、admin 実行で `POST /rest/user/login (email, password)` が採用対象に入り、
ZAP が同 endpoint を攻撃して SQL インジェクション (high) を検出した。

ZAP の認証プレフライトは素の HTTP 再生で marker を検証するため、SPA hash 画面
(`/#/search`) では成功マーカーが応答本文に現れず意図どおり失敗する (fail-safe)。
応答本文が認証状態を反映する API (whoami) で login flow を終えることで認証付き診断が通る。

### ベースライン (測定の副作用を含む)

クローリング・ログイン実測の時点で 3 challenge が解決済み:
Error Handling (404 経路の巡回)、Login Admin (admin ログイン実測)、
Password Strength (登録ユーザー測定の副作用)。

## 実測で発見した製品課題と対応 (2026-11-05)

| # | 発見 | 対応 |
|---|---|---|
| 1 | 一部 JSON 応答で `response.body()` が解決せず探索が停止する | 応答 3 秒・settle 10 秒の期限保護を追加。識別子観測は URL パス要素でも成立 |
| 2 | ZAP proxy 経由の HTTPS が proxy CA で証明書エラーになる | proxy 明示時は context の証明書検証を免除 (自前 proxy のみ) |
| 3 | 1 件の navigation 失敗 (到達不能・証明書) で探索全体が異常終了する | status 0 の観測として記録し続行。実装エラーは従来どおり throw |
| 4 | SPA の XHR 裏付け login form から POST API 候補が生成されない (ZAP が login endpoint を攻撃できない) | **実装済み**。login 実行時の同一Originリクエスト観測 (入力点名のみ) を候補へ合成。admin 実測で login SQLi (high) を検出 |
| 5 | challenge 解決形式の検出確認には payload 実行検証 (browser 実行 + /solve 確認) が必要で、現状の取込所見とは次元が違う | 未対応。browser-dom トラックでの実行検証を検討 |
| 6 | ZAP 認証プレフライトの marker 検証は素の HTTP 再生で行われるため、SPA hash 画面では成功マーカーが現れない | 仕様どおりの fail-safe。応答本文が認証状態を反映する API で login flow を終える運用で対応 (測定ハーネスに記録) |
| 7 | socket.io ポーリング等のエフェメラル URL (時刻付き query) が候補を埋め、診断対象の選定を圧迫する | 測定側で除外した。製品側の候補ランキング (静的・重複パラメータの優先度) は今後課題 |

## 次段階 (2026-11-05 深夜時点の残)

書き込み API 発見 (スクリプト解析)・payload 実行検証・トランスポート除外・client-side 要件化は
実装済み。残る項目:

1. **所見 → payload 実行検証の接続**: 取込所見 (反射系) から検証 URL を組立て
   `verifyFindingExecution` を自動実行する経路 (design/30 30.1 の完成形)。
2. **隠蔽経路の発見** (残 37 件の最大要因): 予算内の辞書的経路発見と入力文書 hint との併用。
3. **静的素材の巡回対象化** (Cryptographic 0/4): 公開鍵・証明書ファイルの候補化。
4. **対話実行による client 側組み立て経路の観測** (workflow テンプレート実行)。
5. **診断実行の拡大実測**: 適用可能 66 challenge へ ZAP・workflow を実行し検出確認済みを増やす。

## 留意事項

- 本測定はクローリング到達性と観測の評価であり、検出率のベンチマークではない (AGENTS.md「ベンチマークについて」)。
- Juice Shop 固有の URL・API 名・セレクタは測定スクリプトと本表にのみ存在し、製品コードには含めない。
