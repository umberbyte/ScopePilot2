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
redirect/DNSまで送信前拒否を要求する計画は、初期FuzzerのZAP経路では`Unsupported`として拒否する。
将来Node管理HTTP client経路を追加する場合は別capabilityとして計画に明示し、暗黙に切り替えない。
どちらの経路でも送る文字列は次の4.の集合管理から供給する。

2026-10-20 時点の製品 API は基準要求全体ではなく `targetUrl` と query position
（name/value）だけを受ける。この限定された経路には Node 管理 HTTP client を実装し、core の
送信前 scope 検査・逐次 2 RPS・redirect 非追従を Enforced として扱う。raw request template、
header/path/body range、ZAP `sendRequest` を含む上記 (a) の完全経路とは区別し、後者が実装されるまで
「Fuzzer 全体の基準実装完了」とは表示しない。

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

- 基準実装の供給元は、runtime bundleでライセンスとhashを確認済みのpayload fileと利用者指定fileとする。
  ZAP同梱fuzzers（fuzzDB/JBroFuzz由来を含む）はインストール済みaddonから参照できるが、製品へ再配布する
  のはファイル単位のライセンス台帳が完成した集合だけとする。Nuclei template は実行規則でありpayload集合へ
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

## 9. 確定事項

1. 基準実装はAPI呼出し1回につき1要求、同時実行1、scheduler window 25件、checkpoint 100件とする。
   ZAP履歴は100送信または5秒ごとに差分取得する。10,000件fixtureで送信数・履歴数・取込数の一致、
   停止overshoot、メモリ上限を検証する。速度値は端末・対象に依存するため完成条件にせず、実測値を能力表へ
   記録する。window拡大やrequestor batchは、正確性とovershootが同じfixtureで改善した場合だけ追加する。
2. ZAP addon本体がApache-2.0でも、JBroFuzz/fuzzDB由来fileを一括して同じ条件と仮定しない。
   `PayloadSet` manifestにfileごとのsource URL、copyright、SPDX、hashを要求し、不明なfileは再配布物から
   除外する。runtimeに既に存在するfileの利用とScopePilotによる再配布を別状態で記録する。
3. 初期抽出式は `status`、headerのexact/literal、body literal、bounded regex、JSON Pointer、
   byte range（0-based half-open）、body length、RTT thresholdとする。regexはpattern 1 KiB、対象1 MiB、
   worker実行100 msを上限とし、timeoutはnon-matchではなく`ExtractorError`にする。任意scriptは許可しない。
4. RateGovernorはorigin別token bucketを使い、既定2 request/秒、burst 1、案件全体concurrency 1、
   最小間隔500 msとする。leaseは25件または残予算の小さい方で払い出し、429/`Retry-After`、5xx増加、
   latency悪化で縮小する。利用者が引き上げる場合も認可と案件上限内で計画hashへ固定する。

根拠: [ZAP Fuzzer documentation](https://www.zaproxy.org/docs/desktop/addons/fuzzer/) はJBroFuzzとfuzzdb由来
fileを含むことを明示し、[zap-extensions license](https://github.com/zaproxy/zap-extensions/blob/main/LICENSE)
はaddon repositoryをApache-2.0で公開する。由来の異なるpayload fileは個別台帳で扱う。
