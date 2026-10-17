# F07 Sequencer

## 1. 対象

token sample の収集、品質統計、可視化、再現可能な判定を提供する。上位は `design/06`, `22`。

## 2. UI/CLI

- Simple: 所見に含まれる要約だけ。
- Advanced: A10 で token 抽出規則、sample 数、収集進捗、分析を表示。
- CLI: `sequencer plan/run/analyze`。送信を伴う run は確認必須。

## 3. モジュール

`TokenExtractor`, `SamplePlan`, `SampleCollector`, `EntropyAnalyzer`, `BitDistributionAnalyzer`, `SequencerAssessment`。最小30、既定100、最大10,000 sample。

## 4. 処理

各 response から bounded extractor で token bytes を抽出し、欠落/重複も sample outcome として数える。分析は観測 sample に対する統計であり、暗号学的安全性を断定しない。algorithm/version と sample hash list を記録する。

## 5. 安全・証跡

収集 request は F05 と同じ rate/scope/stop gate を通す。token 原文は secret 扱いで暗号化し、通常の report には統計だけを載せる。

## 6. 失敗

30 未満は `InsufficientSample`、10,000 超は拒否。抽出失敗率が閾値を超える場合は分析せず `NeedsInput`。結果を脆弱性確定へ自動変換しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F07-UT-001 | `core/test/unit/sequencer/sample-plan.test.ts` | 29/10001 sample | 境界外を拒否 |
| F07-UT-002 | `token-extractor.test.ts` | token 欠落 | missing outcome |
| F07-UT-003 | `sample-collector.test.ts` | duplicate token | sample と重複数を保持 |
| F07-UT-004 | `entropy-analyzer.test.ts` | 固定 bytes | 決定的な低 entropy 結果 |
| F07-UT-005 | `assessment.test.ts` | sample 不足 | 断定せず insufficient |
| F07-UT-006 | `token-evidence.test.ts` | report projection | token 原文を除外 |
| F07-UT-007 | `sample-collector.test.ts` | cancel | 新規 request を発行しない |

## 8. 非単体テスト

既知分布 fixture による algorithm CT、実 request の rate/stop FT、chart 表示 test を行う。
