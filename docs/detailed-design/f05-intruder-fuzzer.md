# F05 Fuzzer

## 1. 対象

payload position、集合、組合せ、rate/lease、checkpoint、抽出、結果集約を扱う。上位は `design/05`, `22`, `27`。

## 2. UI/CLI

- Simple: ガイドラインから生成された確定計画の概要と最終確認のみ。
- Advanced: A07 で request template、position、payload set、上限、extractor を編集。
- CLI: plan file を validate/estimate/run/resume。非対話実行は AutomationGrant 必須。

## 3. モジュール

`PayloadCatalog`, `FuzzTemplate`, `CombinationPlanner`, `RateGovernor`, `LeaseAllocator`, `FuzzRunner`, `ResponseExtractor`, `ResultClusterer`。payload の供給元、license、version、hash を catalog に必須化する。

## 4. 計画と実行

初期既定は concurrency 1、2 RPS、window/lease 25、checkpoint 100。組合せを materialize せず index で生成し、見積通信数が plan 上限を超えたら確認前に拒否する。worker は lease 範囲だけを一度ずつ処理し、checkpoint から未完了 index を再配布する。

## 5. 安全・証跡

各 request 前に scope、停止、deadline、rate token を評価する。ZAP `sendRequest` 経路の実挙動は委譲制御として記録する。攻撃 payload は許可するが、脆弱性情報から自動生成せず、catalog 供給元を記録する。

## 6. 失敗

組合せ overflow、無制限 generator、危険 extractor、license 不明は validation error。cancel 後の結果は late result として隔離し、新たな送信を認めない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F05-UT-001 | `core/test/unit/fuzzer/combination-planner.test.ts` | cartesian 件数 overflow | 送信前に拒否 |
| F05-UT-002 | `rate-governor.test.ts` | 2 RPS virtual clock | token 間隔を遵守 |
| F05-UT-003 | `lease-allocator.test.ts` | lease 25 | 重複せず上限内を払い出す |
| F05-UT-004 | 同上 | worker crash 後 resume | 完了 index を再送しない |
| F05-UT-005 | `fuzz-runner.test.ts` | cancel 中 | adapter の追加呼出しなし |
| F05-UT-006 | `payload-catalog.test.ts` | source/version/license 欠落 | catalog 登録拒否 |
| F05-UT-007 | `response-extractor.test.ts` | bounded regex 超過 | timeout/size error |
| F05-UT-008 | `result-clusterer.test.ts` | 同 status/length/hash | 同 cluster に集約 |

## 8. 非単体テスト

現行の query position 経路は `NodeFuzzTransport` を所有 HTTP server と結合し、query 反映、
cookie、redirect 非追従、応答 metadata/hash、2 RPS、通信 log を常時 IT で確認する。
raw request template を追加するときは、ZAP sendRequest の改行、binary、cookie 挙動を gated IT、
停止・resume・計画 hash 検証を simulation FT で行う。
