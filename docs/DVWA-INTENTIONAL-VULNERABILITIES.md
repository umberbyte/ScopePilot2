# DVWAに意図して含まれる脆弱性一覧

## 調査範囲

公式DVWAリポジトリの2026年10月18日時点のコミット
[`a1978a2`](https://github.com/digininja/DVWA/commit/a1978a2fed195acd093010af6395f86a281537ca)
を基準に調査した。

対象は、[公式メニュー定義](https://github.com/digininja/DVWA/blob/a1978a2fed195acd093010af6395f86a281537ca/dvwa/includes/dvwaPage.inc.php)、
[ソース表示機能のモジュール一覧](https://github.com/digininja/DVWA/blob/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/view_source_all.php)、
各モジュールのヘルプおよび実装である。

[公式README](https://github.com/digininja/DVWA/blob/a1978a2fed195acd093010af6395f86a281537ca/README.md)
には、文書化されていない脆弱性も意図的に含むと明記されている。しかし、それらの公式な完全一覧は存在しないため、本書はソース上で演習モジュールとして識別できるものを網羅する。

同種の脆弱性が複数のページまたは難易度に存在する場合は、一般名単位で統合した。一方、APIおよび暗号モジュール内のように、原因とCWEが異なるものは別項目としている。

## 一覧

| 含まれている脆弱性の一般名 | CWE番号 | URLまたはディレクトリ | 脆弱性の仕様 |
|---|---|---|---|
| ブルートフォース攻撃対策の不備 | [CWE-307](https://cwe.mitre.org/data/definitions/307.html) | [`/vulnerabilities/brute/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/brute) | ログイン試行回数を適切に制限しない。Lowは無制限、Mediumは失敗時に固定時間待機するだけ、HighはCSRFトークンを付与するものの試行回数を制限しないため、自動化したパスワード推測を継続できる。 |
| OSコマンドインジェクション | [CWE-78](https://cwe.mitre.org/data/definitions/78.html) | [`/vulnerabilities/exec/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/exec)<br>[`/vulnerabilities/api/v2/health/connectivity`](https://github.com/digininja/DVWA/blob/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/api/src/HealthController.php) | classicモジュールでは入力されたIPアドレスをpingコマンドへ組み込み、シェルの連結記号などによって任意コマンドを実行できる。APIラボでもJSONの`target`を検証せず、`exec("ping -c 4 " . $target)`へ連結している。同種なので統合した。 |
| クロスサイト・リクエスト・フォージェリ（CSRF） | [CWE-352](https://cwe.mitre.org/data/definitions/352.html) | [`/vulnerabilities/csrf/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/csrf) | 認証済み利用者のパスワード変更を、外部ページや細工したURLから実行させる。Lowはトークンなし、Mediumは偽装可能な参照元検査、Highはトークンを使用するが、XSSなど別の脆弱性と組み合わせて取得・悪用する演習になっている。 |
| ローカル／リモートファイルインクルージョン | [CWE-98](https://cwe.mitre.org/data/definitions/98.html)、[CWE-22](https://cwe.mitre.org/data/definitions/22.html) | [`/vulnerabilities/fi/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/fi) | `page`パラメーターなどで指定されたファイルをPHPのinclude処理へ渡す。Lowでは直接指定でき、Mediumでは不完全な文字列除去、Highでは不十分なワイルドカード制限を使用する。ローカルファイルの読取り、リモートファイル取込み、アップロード機能との連鎖を想定している。 |
| 無制限・危険なファイルアップロード | [CWE-434](https://cwe.mitre.org/data/definitions/434.html) | [`/vulnerabilities/upload/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/upload) | Lowは内容や拡張子を実質検査せずPHPファイルを保存できる。Mediumは利用者が送信するMIME型に依存し、Highの画像処理も他の脆弱性との連鎖で突破可能。アップロードしたコードの実行や、ファイルインクルージョンとの組合せを演習する。 |
| CAPTCHA・アンチオートメーションの迂回 | [CWE-602](https://cwe.mitre.org/data/definitions/602.html)、[CWE-489](https://cwe.mitre.org/data/definitions/489.html)<br>一般分類：[CWE-804](https://cwe.mitre.org/data/definitions/804.html) | [`/vulnerabilities/captcha/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/captcha) | CAPTCHAを通過せずパスワードを変更できる。Lowは第2段階へ直接POST可能、Mediumはクライアント側の`passed_captcha`を信頼する。Highには開発用の固定値と特定User-Agentによる迂回経路が残されている。 |
| SQLインジェクション（通常型・ブラインド型） | [CWE-89](https://cwe.mitre.org/data/definitions/89.html) | [`/vulnerabilities/sqli/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/sqli)<br>[`/vulnerabilities/sqli_blind/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/sqli_blind) | 利用者入力をSQL文へ直接連結する。通常型ではUNION等により利用者情報やパスワードハッシュを取得できる。ブラインド型では真偽による応答差や時間差を利用してDB情報を推測する。画面と観測方法は異なるが、原因が同じSQLインジェクションなので統合した。 |
| 推測可能なセッションID | [CWE-330](https://cwe.mitre.org/data/definitions/330.html) | [`/vulnerabilities/weak_id/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/weak_id) | `dvwaSession` Cookieを、Lowでは単純な連番、Mediumでは現在時刻、Highでは連番のMD5値から生成する。複数の値を収集すれば生成規則を特定でき、他利用者のセッションIDを予測できる。 |
| クロスサイトスクリプティング（反射型・格納型・DOM型） | [CWE-79](https://cwe.mitre.org/data/definitions/79.html) | [`/vulnerabilities/xss_r/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/xss_r)<br>[`/vulnerabilities/xss_s/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/xss_s)<br>[`/vulnerabilities/xss_d/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/xss_d) | 反射型はリクエスト値を応答HTMLへ出力し、格納型は名前・メッセージをDBへ保存して閲覧者ごとに実行する。DOM型はURLのクエリやフラグメントをブラウザー側JavaScriptが安全でない方法でDOMへ挿入する。実装場所は異なるが一般名が同じため統合した。 |
| Content Security Policy（CSP）の迂回 | [CWE-693](https://cwe.mitre.org/data/definitions/693.html)（包括分類）、[CWE-79](https://cwe.mitre.org/data/definitions/79.html) | [`/vulnerabilities/csp/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/csp) | CSP自体の欠陥ではなく、許可元の範囲が広すぎる、利用者が制御できるnonceを信頼する、JSONPのコールバック名を操作できる、といった実装ミスを用意している。制限を迂回してページ上で任意JavaScriptを実行する。 |
| クライアント側セキュリティ制御への依存 | [CWE-602](https://cwe.mitre.org/data/definitions/602.html) | [`/vulnerabilities/javascript/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/javascript) | 成功文字列とトークンの生成・検証に必要なロジックをブラウザーへ配信している。難読化、外部JavaScript、遅延実行などを解析・改変することで、トークンを生成して制御を通過できる。クライアントへ送ったコードは利用者が変更できることを示す演習である。 |
| 認可不備・IDORを含むアクセス制御の不備 | [CWE-862](https://cwe.mitre.org/data/definitions/862.html)、[CWE-639](https://cwe.mitre.org/data/definitions/639.html) | [`/vulnerabilities/authbypass/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/authbypass)<br>[`/vulnerabilities/bac/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/bac) | メニューを隠すだけでURLを保護しない、画面は保護してもユーザーデータAPIを保護しない、GETのみ確認して更新POSTを見落とす、といった機能単位の認可漏れを含む。BAC側では`user_id`パラメーターやCookieを信頼し、他人のプロフィールを閲覧できるIDORを実装している。 |
| オープンリダイレクト | [CWE-601](https://cwe.mitre.org/data/definitions/601.html) | [`/vulnerabilities/open_redirect/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/open_redirect) | 利用者が指定した`redirect`先へ検証不十分なまま転送する。Lowは任意URL、Mediumはプロトコル相対URL、Highは許可文字列を含むかだけで判断するため、外部のフィッシングサイトなどへ誘導できる。 |
| 弱い独自暗号・固定暗号鍵 | [CWE-327](https://cwe.mitre.org/data/definitions/327.html)、[CWE-321](https://cwe.mitre.org/data/definitions/321.html) | [`/vulnerabilities/cryptography/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/cryptography)（Low） | 平文を固定鍵`wachtwoord`との反復XORで変換し、Base64で表現して暗号のように扱う。既知平文と暗号文のXORから反復鍵を回収でき、傍受したメッセージを復号できる。 |
| ECBモードによる暗号トークン改ざん | [CWE-327](https://cwe.mitre.org/data/definitions/327.html) | [`/vulnerabilities/cryptography/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/cryptography)（Medium） | セッショントークンをAES-128-ECBで暗号化する。各ブロックが独立しており完全性も検証しないため、複数利用者の暗号文ブロックを組み替え、利用者名・有効期限・権限を組み合わせた管理者トークンを作成できる。 |
| CBCパディングオラクル | [CWE-203](https://cwe.mitre.org/data/definitions/203.html) | [`/vulnerabilities/cryptography/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/cryptography)（High） | AES-128-CBCの復号結果について、パディングエラー、形式エラー、利用者不在、成功を異なるステータス・メッセージで返す。攻撃者はこの応答差をオラクルとして利用し、暗号文の復号や管理者トークンの作成を進められる。 |
| 廃止APIの残存による機微情報露出 | [CWE-200](https://cwe.mitre.org/data/definitions/200.html) | [`/vulnerabilities/api/v1/user/`](https://github.com/digininja/DVWA/blob/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/api/src/User.php)<br>[`/vulnerabilities/api/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/api)（Low） | 画面はパスワードを除外するv2 APIを使用する一方、旧v1 APIが到達可能なまま残っている。v1の利用者一覧はID・名前・権限に加えてパスワードハッシュも返すため、APIバージョンを変更するだけで機微情報を取得できる。 |
| マスアサインメント | [CWE-915](https://cwe.mitre.org/data/definitions/915.html) | [`/vulnerabilities/api/v2/user/{id}`](https://github.com/digininja/DVWA/blob/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/api/src/UserController.php)<br>[`/vulnerabilities/api/`](https://github.com/digininja/DVWA/tree/a1978a2fed195acd093010af6395f86a281537ca/vulnerabilities/api)（Medium） | 通常画面は名前だけを更新するが、更新APIはリクエストJSONに`level`が含まれていると権限属性まで書き換える。利用者が未提示の属性を追加して`level: 0`を送信すると、自分を管理者へ昇格できる。 |

## 補足

- `Impossible`レベルは各テーマの対策済み比較実装であるため、脆弱性として別項目にはしていない。
- `/vulnerabilities/bac/`は当該コミットではメニュー登録がコメントアウトされているが、専用ディレクトリ、ヘルプ、難易度別ソースが存在し、ソース表示一覧にも登録されているため収録した。
- CWEは、各難易度の具体的な原因が異なる場合に複数併記している。
