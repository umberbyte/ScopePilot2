# 具体案: ZAP再送ワークベンチ（手動リクエストエディタ相当の半自動化）

ZAP非対応ガイドライン項目の代替検証（手動リクエストエディター手順）のうち
「リクエストの書き換え送信 → 応答比較 → 記録」を、ZAP REST API `core/action/sendRequest`
（＝手動リクエストエディタの「送信」と同一機能）を使ってScopePilotから行えるようにする案。

## 1. 実機検証で確定した前提（ZAP 2.17.0・2026-10-17）

| # | 事項 | 検証結果 |
|---|---|---|
| 1 | `core/action/sendRequest` は手動リクエストエディタ相当か | curlから生リクエスト（`GET /login.php HTTP/1.1\r\nHost: …`）を送り、RTT付きの応答全文が返ることを確認 |
| 2 | 送受信はZAP履歴に残るか | 残る（`numberOfMessages` が増加）。既存の `core/view/messages`・HAR取得で証跡化できる |
| 3 | Safeモードで送れるか | **送れない**。`setMode safe` 後は `{"code":"mode_violation","message":"Operation not allowed for current mode"}` で拒否。再送にはstandardモード＋明示承認が必要 |
| 4 | `-config mode=SAFE` / `-safe` は効くか | 効かない（`-safe` は未対応オプションで起動失敗、`-config mode=SAFE` はstandardのまま）。Safe化は起動後の `setMode` APIのみ有効（ScopePilotの `EnsureSafeModeAsync` と同じ手法） |
| 5 | `-config api.port` | 別ポートは開かず、APIはプロキシリスナー（既定8080）で応答。API URLは実行時に確認する作りが必要 |
| 6 | FuzzerアドオンのAPI | fuzz-beta 13.16.0 にAPI実装クラスが無く、RESTからファジングタスクは登録不可。ファジングはZAP画面機能（共通手順⑥）のまま |
| 7 | MCP経路 | 公式MCP Integrationアドオン（alpha）に sendRequest 相当ツール無し（Extenderスクリプトで追加は可能）。コミュニティの dotnet-zap-mcp にも無し |

## 2. 設計原則（AGENTS.md準拠）

- 2026-10-17 の方針改訂（`AGENTS.md`、`docs/burp-professional-replacement-spec.md` 3.1）により、
  攻撃コード・ペイロード（自動反復送信を含む）の実装は認められている。本ワークベンチ（F04相当）は
  **手動編集・送信に限定**した機能として設計し、送る内容は利用者が編集して決める。ペイロード集合の
  管理と自動反復送信は仕様書F05（Intruder相当）の範囲で実装する。使用するのはZAPが提供する機能
  （sendRequest）の呼び出し。ZAP同梱定義由来の文字列を利用者が貼り付けることは妨げない。
- 探索（Safeモード・再送不可）と診断（明示承認の上 standard・再送可）を分離する。
  この境界はZAP自身のモード機構が強制する（前提3）。ワークベンチは診断側に置く。
- 送信は1件ずつ・人が確認してから。一括送信・自動反復は実装しない。
- すべて許可Origin・禁止操作・通信数・実行時間の安全制御の内側。証跡は追跡可能に、
  秘密値はマスク。警告・結果は「実影響未確認」と表示。検出件数を性能基準にしない。

## 3. 構成

### 3.1 ZapProxyApi への追加（Services/ZapProxyApi.cs）

```csharp
// core/action/sendRequest — 手動リクエストエディタの送信と同じ機能。
public Task<ZapSentRequest?> SendRequestAsync(string rawRequest, bool followRedirects, CancellationToken token)
// core/action/setMode・core/view/mode は既存。再送セッションは standard で起動する。
```

- リクエストは `request` クエリパラメータへURLエンコード（CRLF含む生テキスト）。
- 応答JSON（rtt・responseBody・生レスポンス）をそのまま返し、Service層で解析。

### 3.2 ZapResendService（新規）

- **再送セッション**: ManagedZapProxy と同じ起動引数（127.0.0.1限定・APIキー都度生成・
  案件専用ホーム `runs/resend-<時刻>-<id>/zap-home`）で、モードを standard で起動。
  探索プロキシ（Safe）とは別プロセス・別ホーム。セッションはUIで明示的に開き、閉じるまで保持。
- `SendAsync(project, rawRequest, followRedirects, themeNo, token)`:
  1. `ApiRequestFormatter.EnsureAllowed`（許可Origin）
  2. 禁止操作ヒント（案件の禁止操作語彙＋メソッド/パス/本文の単純一致。完全検出でない旨を表示して警告）
  3. 通信数カウント（MaxRequestsから減算・上限で送信不可）
  4. sendRequest呼び出し → 応答・RTT取得
  5. 元リクエスト（必要なら再送）との差分生成（ステータス行・ヘッダ・本文・RTT）
  6. `runs/resend-…/` へ raw-request.txt / response.txt / diff.txt / engagement.json
     （送信者・日時・テーマNo.・followRedirects）を追記
- 取込: `DiagnosticObservation`（RuleId=`manual-resend`、Title=テーマ名、Url/Method/Parameter、
  State=実影響未確認、Evidence=再送ランの証拠参照）を案件へ追加。

### 3.3 UI: 診断タブ内「再送ワークベンチ」

1. **元リクエスト選択**: 観測通信／採用候補の代表／ZAPランの selected.har エントリから選ぶ。
   生リクエスト（手動リクエストエディタと同じ書式）を編集欄へ展開。
2. **編集**: パラメータ・ヘッダ・Cookie・メソッドを書き換え。Cookie 等の秘密値は既定で
   マスク表示（送信時はオリジナル値を使用。値の複写・保存はしない）。
3. **テーマ選択**（元資料ZAP非対応33テーマ）: 手順・「注意（安全制御・事前合意）」列を表示し、
   記録にテーマNo.を残す。シミュレーション資料の「ZAP手動操作記録」が手順の雛形になる。
4. **送信**: 初回はアクティブ診断と同じ明示承認（ACTIVE入力・セッション単位）。
   followRedirects 切替可。
5. **比較表示**: 元応答 vs 再送応答の差分（ステータス／ヘッダ／本文／RTT）。
   判定は人が行う（テーマの「出力の見方・判定」を併記）。
6. **記録**: 診断観測へ追加。レポートの「参照ガイドライン」に手動再送として表示。

### 3.4 本ワークベンチの範囲外とすること

- 一括送信・自動反復・ペイロード集合の管理（方針上は実装可能。仕様書F05（Intruder相当）で実装する）
- 脆弱性情報からの攻撃コードの自動生成（`AGENTS.md` により実施しない）
- ファジングのAPI化（前提6で不可。ZAP画面のFuzzerのまま。ペイロード列のコピー補助のみ検討可）
- AIエージェント（z.ai等）へ再送の実行を渡すMCP構成（安全制御の主体がScopePilotでなくなるため。
  公式MCPアドオンはalphaで sendRequest ツールも無い）

## 4. 安全制御のまとめ

| 制御 | 実装 |
|---|---|
| 許可Origin | 送信前に EnsureAllowed。違反は送信不可 |
| 禁止操作 | 案件の禁止操作語彙との単純一致で警告＋確認（保証しない旨を表示） |
| 通信数 | 1送信=1カウント。MaxRequestsの内側 |
| 実行形態 | ZAPモード機構（Safe=拒否）＋明示承認（ACTIVE）＋1件ずつ送信 |
| 証跡 | ZAP履歴＋runs/resend-*＋DiagnosticObservation（テーマNo.付き） |
| 秘密値 | 編集欄はマスク表示、保存時にCookie/Set-Cookie/Authorization等をマスク |
| 誤解防止 | 「実影響未確認」表記・判定は人・検出件数を基準にしない |

## 5. 実装ステップ（概算）

1. `ZapProxyApi.SendRequestAsync` ＋再送セッション起動・モード確認（〜0.5日）
2. `ZapResendService`（送信・差分・証跡・取込）（〜1日）
3. ワークベンチUI（診断タブ）（〜1〜1.5日）
4. 記録・レポート連携・単体テスト・ドキュメント（〜1日）

受け入れ基準: 「利用者が観測済みリクエストを書き換えて送信し、元応答との差分を比較し、
テーマ・証跡付きで案件に記録できる」。検出数・検出率は基準にしない（AGENTS.md）。

## 6. 前提の再確認事項（実装時に）

- ZAP 2.17.0の `sendRequest` 応答JSONの正確なスキーマ（responseBody のほかヘッダ情報の有無）
  — 検証時は本文とRTTを確認。生レスポンス全体の取得方法（`network` コンポーネントの
  `sendRequest` との差分）を確認してから解析部を固定する
- 再送セッションのZAPアドオン要件（Automation Frameworkは不要・軽量起動にできるか）
- 履歴からの再送対象の取り出し（HARエントリ→生リクエスト文字列化の書式）
