# 05 Fuzzer（Intruder相当） 概要設計

対応要件: 仕様書 F05・3.1（自動反復送信を標準機能化）・5.1/5.3（ペイロード集合の版管理）

## 1. 目的

挿入位置×ペイロード集合の自動反復送信（Burp Intruder相当）を、認可と通信上限の内側で
標準機能として提供する。2026-10-17 の方針改訂により攻撃コード・ペイロードの実装は
認められている（AGENTS.md）。脆弱性情報からの攻撃コード自動生成のみ引き続き行わない。

## 2. 検証済み前提（ZAP 2.17.0実機・公式ドキュメント）

- ZAP Fuzzer（fuzz-beta 13.16.0）に REST API が無い。Automation Framework にも fuzz ジョブが無い。
- `core/action/sendRequest` は standard モードで任意の生要求を送れる（04と同じ前提）。
- Automation Framework の `requestor` ジョブ: url/method/headers/data/responseCode/user を計画
  （YAML）から送れる。レート制限パラメータは無い。`delay` ジョブで時間制御のみ可能。

## 3. 実現経路

| 案 | 構成 | 利点 | 課題 |
|---|---|---|---|
| (a) `sendRequest` loop（基準実装） | core が組合せを遅延生成し、ZAP `sendRequest` を予算leaseごとに呼ぶ | 1件単位の範囲・速度・停止・抽出・checkpointを制御できる | REST overhead とZAP履歴増加。batch sizeと履歴回収の調整が必要 |
| (b) requestor計画 | 小さいbatchをAutomation Frameworkのrequestor jobへ渡す | ZAP側でbatchを実行でき、計画YAMLを証拠にできる | 個別送信の直前制御が弱い。最大overshootと応答相関を実測できる場合だけ採用 |

A1 は (a) を採用する。(a)(b) とも送信は ZAP が行うため egress は Delegated（22§3）だが、(a) は 1 件ごとに
送信前の入力 scope 検査・followRedirects 無効・逐次ペーシング・即時停止を課せるため overshoot が小さく
実測しやすい。(b) は個別送信の直前制御が弱い。(b) は [22](22-execution-control.md) の Delegated 条件
（固定版での最大 overshoot 実測・開示）と性能上の効果を fixture で示せた場合だけ最適化として追加する。
redirect/DNS まで Enforced にしたい場合は ZAP ではなく Node 管理 HTTP client 経路を選ぶ（A0 で要否を判断）。
どちらの経路でも送る文字列は次の4.の集合管理から供給する。

## 4. ペイロード集合の管理（PayloadSet）

```text
Domain:
  PayloadSet {
    Id, 名称, 区分(Fuzz位置/認証/業務ロジック等), 供給元(kind=Upstream|User),
    上流(ZAP同梱fuzzers/審査済み公開辞書/利用者ファイル), 版・取得日時・SHA-256,
    ファイル一覧(複数可), 利用許可ランク(Stable/Review), 有効/無効 }
Services:
  PayloadSetStore: 同期・審査状態・版固定。実行開始時に集合hashを計画へ固定（21の更新管理と接続）
```

- 既定の供給元は**ZAP同梱のfuzzers（fuzzDB/JBroFuzzファイル群）**を第一候補とし、
  審査済み公開辞書と利用者指定ファイルを続ける。Nuclei template は実行規則でありpayload集合へ
  流用しない。製品独自の攻撃辞書は初期には作らない。
- 上流の取得・審査・固定は 21（UpdateManager）と同じ手順・表示で扱う（供給元ごとの
  最終確認・最終成功・使用中の版・保留件数）。

## 5. コンポーネント構成

```text
FuzzerJob（JobOrchestrator配下）:
  入力: 基準要求（観測/採用/記録）＋挿入位置（パラメータ/ヘッダ/パス/本文のレンジ指定）
        ＋PayloadSet＋判定条件（応答コード/本文grep/長さ/時間のしきい値・抽出式）
  生成: 組合せを遅延列挙する実行キュー。組合せ数の事前試算と上限確認を必ず表示
  実行: sendRequest loopを案件の通信上限・速度上限・同時接続の内側で実行（22）。
        429/5xx増加・認証切れで一時停止し、確定済みindexから再開
  判定: 履歴からの抽出・マッチ結果の表示（ヒット/差分/時間）。誤検出抑制の確定は人が行う
```

## 6. データモデル

- `FuzzRunRecord`: 基準要求・挿入位置・PayloadSet(hash)・生成数・実行数・停止理由・
  ヒット一覧（→Exchange・DiagnosticObservation参照）。
- ヒットは「実影響未確認」で取込。確定は F19 の確認状態へ。

## 7. 安全制御と証跡

- 実行には認可（許可操作区分 `Fuzz`）が必須。計画生成時に組合せ数・想定通信数を表示して
  確認させる（上限超過は計画の時点で拒否）。
- 禁止語彙検査を基準要求と代表ペイロードに対して実施し、警告表示（保証しない旨）。
- 全送信が案件の共有通信上限から減算される。秘密値マスクは04と同じ。

## 8. UI

- 「Fuzzer」画面: 基準要求選択→位置指定（グリッド上のハイライト）→集合選択→判定条件→
  事前試算→実行→結果表（抽出列・差分ビューア）。

## 9. 未解決事項（A0）

1. sendRequest loop のbatch size、数万要求規模の速度、ZAP履歴取込時間
2. ZAP同梱fuzzersのライセンス・再配布条件の確認（fuzzアドオン配下のファイル群）
3. 抽出式（grep/正規表現/位置指定）の構文の初期セット
4. レート制御の単位（Origin別RPS・並列数・間隔）と予算leaseの大きさ
