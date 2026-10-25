# DVWA既知脆弱性とScopePilot2診断結果の検出差分

## 1. 比較対象

### 基準資料

- `docs/DVWA-INTENTIONAL-VULNERABILITIES.md`
- DVWA公式ソースから整理した18分類を比較基準とする。

### ScopePilot2の診断出力

- JSON: `C:\Users\GoSugawara\Documents\案件フォルダ\3\reports\diagnostic-report-2026-10-25T06-43-33-442Z.json`
- Markdown: `C:\Users\GoSugawara\Documents\案件フォルダ\3\reports\diagnostic-report-2026-10-25T06-43-33-442Z.md`
- 報告書内の生成日時: 2026-10-25 15:32:33 JST
- 診断期間: 2026-10-22 23:36:16 JST ～ 2026-10-25 15:31:17 JST
- 診断方式: Web探索、ZAP 2.17.0による能動診断、ブラウザーDOM観測
- 最終出力: High 7件、Medium 7件の計14所見
- 生データ: 146件（High 49、Medium 39、Low 36、Info 22）

## 2. 判定基準

同じURLに何らかの警告が存在するだけでは検出扱いにしない。DVWAが意図した脆弱性の原因、攻撃手順または成立結果が所見として記録されているかで判定する。

- **検出**: DVWAの意図した脆弱性と一致する所見および対象URLがある。
- **部分漏れ**: 関連する警告または候補はあるが、DVWA固有の攻撃方法や成立を確認していない。
- **検出漏れ**: 最終出力および生データのどちらにも対応する所見がない。

報告書の「お客様のご指示によりLow以下は省略されています」という条件も考慮し、生データのLow・Info所見まで確認した。

## 3. 集計結果

| 判定 | 分類数 | 割合 |
|---|---:|---:|
| 検出 | 4 / 18 | 22.2% |
| 部分漏れ | 2 / 18 | 11.1% |
| 検出漏れ | 12 / 18 | 66.7% |

検出できた分類は次の4件である。

1. OSコマンドインジェクション
2. ローカル／リモートファイルインクルージョンのうちRFI
3. SQLインジェクション（通常型・ブラインド型）
4. オープンリダイレクト

## 4. 検出漏れ・部分漏れ一覧

| 脆弱性 | CWE | 判定 | 最新診断との比較結果 |
|---|---|---|---|
| ブルートフォース攻撃対策の不備 | CWE-307 | 検出漏れ | `/vulnerabilities/brute/`へZAP Active Scanを実施しているが、試行回数制限の欠如を示す所見はない。SQLインジェクション等の別種警告のみ記録されている。 |
| クロスサイト・リクエスト・フォージェリ（CSRF） | CWE-352 | 検出漏れ | `/vulnerabilities/csrf/`には到達したが、`workflow-state`が「追加入力待ち」で終了した。報告書の「Anti-CSRFトークンが使用されていない」はXSS、upload、exec等の別画面に対する警告であり、パスワード変更CSRFを検出していない。 |
| 無制限・危険なファイルアップロード | CWE-434 | 検出漏れ | `/vulnerabilities/upload/`は探索済みだが、`upload-workflow`が「許可されたサンプルファイルと成功判定が必要」として未実施。危険なPHPファイルの保存・実行を試験していない。 |
| CAPTCHA・アンチオートメーションの迂回 | CWE-602、CWE-489 | 検出漏れ | `workflow-state`が追加入力待ち。生データの「input.value → eval」候補は、CAPTCHAの二段階処理迂回や開発用固定値による迂回を示すものではない。 |
| 推測可能なセッションID | CWE-330 | 検出漏れ | `/vulnerabilities/weak_id/`は到達したが、`session-analysis`が「トークン抽出位置と再送手順が必要」で終了。連番、時刻、MD5連番の生成規則を評価していない。 |
| クロスサイトスクリプティング（反射型・格納型・DOM型） | CWE-79 | 部分漏れ | 生データにはDOM型の`location/input → document.write`候補が1件あるが、Info扱いで最終出力から省略され、成立確認もない。反射型・格納型の所見はなく、格納型はワークフローが追加入力待ちである。 |
| Content Security Policy（CSP）の迂回 | CWE-693、CWE-79 | 部分漏れ | `/vulnerabilities/csp/`で「CSP重要ディレクティブの定義漏れ」は検出した。しかし、許可ドメインを利用した外部スクリプト実行、nonce操作、JSONPコールバック改変というDVWA固有の迂回方法は試験・立証していない。 |
| クライアント側セキュリティ制御への依存 | CWE-602 | 検出漏れ | `/vulnerabilities/javascript/`では疑わしいコメントをInfoとして記録しただけで、トークン生成処理の解析・改変による制御迂回を検出していない。`session-analysis`も追加入力待ちである。 |
| 認可不備・IDORを含むアクセス制御の不備 | CWE-862、CWE-639 | 検出漏れ | `/vulnerabilities/authbypass/`と`get_user_data.php`には到達したが、比較用の複数roleがないため`authorization-differential`が追加入力待ち。`/vulnerabilities/bac/`は探索自体されていない。 |
| 弱い独自暗号・固定暗号鍵 | CWE-327、CWE-321 | 検出漏れ | cryptography画面は探索済みだが、`cryptography-review`が追加入力待ち。反復XOR、固定鍵、既知平文からの鍵回収を評価していない。 |
| ECBモードによる暗号トークン改ざん | CWE-327 | 検出漏れ | AES-ECBのブロック構造や複数トークンのブロック差し替えを試験していない。cryptography画面に付いたSQLインジェクション警告は本脆弱性と無関係である。 |
| CBCパディングオラクル | CWE-203 | 検出漏れ | 復号結果の応答差を繰り返し観測するオラクル試験が行われておらず、対応する所見がない。 |
| 廃止APIの残存による機微情報露出 | CWE-200 | 検出漏れ | `/vulnerabilities/api/v2/user/`までは到達したが、パスワードハッシュを返す`/api/v1/user/`を探索していない。`api-schema`も追加入力待ちである。 |
| マスアサインメント | CWE-915 | 検出漏れ | `/api/v2/user/{id}`に`level`を追加するPUTリクエストを送信していない。API一覧のGETだけで終了し、権限昇格を検証していない。 |

## 5. 同分類内の到達・検証漏れ

一般名としては検出できた分類にも、次の実装箇所または攻撃形態の漏れがある。

| 分類 | 検出済み | 未検出・未検証 |
|---|---|---|
| OSコマンドインジェクション | `/vulnerabilities/exec/`で`/etc/passwd`を取得する成立証拠あり | `/api/v2/health/connectivity`は探索・診断されていない |
| ファイルインクルージョン | 外部URLを指定するRFI所見あり | ローカルファイル読取りの成立証拠なし |
| SQLインジェクション | `/vulnerabilities/sqli/`および`/vulnerabilities/sqli_blind/`で所見あり | 所見がcryptography、CSP、JavaScript、XSS等の無関係画面まで過度に集約されており、URL単位の真偽確認が必要 |
| オープンリダイレクト | Low実装で外部URLへのHTTP 302を確認 | Medium／Highの迂回パターンは未評価 |

## 6. 「追加入力待ち」で終了した診断

| 対象 | 診断方法 | 未実施理由 |
|---|---|---|
| `/vulnerabilities/csrf/` | `workflow-state` | 保存型XSS、CSRF、CAPTCHA等の状態遷移・確認手順が必要 |
| `/vulnerabilities/upload/` | `upload-workflow` | 許可されたサンプルファイルと成功判定が必要 |
| `/vulnerabilities/captcha/` | `workflow-state` | 状態遷移・確認手順が必要 |
| `/vulnerabilities/weak_id/` | `session-analysis` | トークン抽出位置と再送手順が必要 |
| `/vulnerabilities/xss_s/` | `workflow-state` | 保存型XSSの状態遷移・確認手順が必要 |
| `/vulnerabilities/javascript/` | `session-analysis` | トークン抽出位置と再送手順が必要 |
| `/vulnerabilities/authbypass/` | `authorization-differential` | 比較する複数roleと期待結果が必要 |
| `/vulnerabilities/cryptography/` | `cryptography-review` | 対象データ、保護要件、復号・検証手順が必要 |
| `/vulnerabilities/api/` | `api-schema` | OpenAPI schemaまたは有効なrequest body例が必要 |

## 7. Low以下省略の影響

生データ146件のうち、最終報告書にはHighとMediumだけが14所見へ集約されている。Low以下の省略によって表面上消えたDVWA関連候補は主にDOM-XSS候補である。

一方、残る12分類はLow・Infoを含む生データにも対応する検出結果がない。このため、検出漏れの主要因は報告書フィルターではなく、専用診断ワークフローが追加入力待ちのまま実行されなかったこと、必要なAPI・BAC経路を探索できなかったことにある。

## 8. 結論

現在のScopePilot2は、ZAPが標準的な単一リクエストで確認できるインジェクション系を中心に検出できている。一方で、複数回の状態遷移、複数role比較、トークン系列分析、暗号データ解析、API schemaに基づくリクエスト生成を必要とする脆弱性は検出結果へ到達していない。

DVWAの18分類を回帰基準にする場合、少なくとも次の専用自動診断を追加または実行可能にする必要がある。

1. 認証試行回数とロックアウトの観測
2. CSRF・CAPTCHA・保存型XSSの状態遷移実行
3. 安全なサンプルを使ったファイルアップロード確認
4. セッションID系列の予測可能性分析
5. 複数roleによる認可差分検証
6. XOR、ECB、CBCパディングオラクルの暗号診断
7. API旧版探索、OpenAPI取込み、マスアサインメント検証
8. CSP許可元、nonce、JSONPを対象とした実行確認
