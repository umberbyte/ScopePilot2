# 09 受動診断 概要設計

対応要件: 仕様書 F10（受動診断）・3.1 F10行（取込と実際の再送を区別）

## 1. 目的

観測済みの応答を解析し、追加の対象通信を発生させない診断として ZAP のパッシブルールを
自動実行する。「保存済み通信のパッシブ解析」と「実際の再送を伴う診断」を明確に区別して
表示・記録する。

## 2. 再利用する現行資産

- `Services/ZapHandoffService.CreatePlan`: passiveScan-wait ジョブを含む計画生成（HAR取込→受動待機）
- `Services/ZapResultImporter`: Traditional JSON からの警告取込（許可Originフィルタ・重複除外）
- `Services/JapaneseZapAlertCatalog`: 日本語解説辞書
- 探索の記録通信（fast-capture.har・zap-ai-capture.har・手動プロキシのHttpExchange）

## 3. コンポーネント構成

```text
PassiveScanJob（Orchestrator配下・既存計画をラップ）:
  入力: 対象通信（探索記録/手動プロキシ記録/取込HAR）
  実行: ZAP -autorun（import HAR → passiveScan-wait）。再送は行わない
  取込: 警告→DiagnosticObservation（State=実影響未確認）。ルール品質（release/beta/alpha）を添える
RuleQualityChannel（21と接続）: 受動ルールの品質チャネル選択（既定=release。beta/alphaは別チャネル）
```

- 受動診断は通信を発生させないため、認可の許可操作区分では `Passive`（最も低い区分）で実行できる。
  ただし取込HARの対象が許可Origin内であることの検査は必須（既存の取込時検査を維持）。

## 4. データモデル

- `DiagnosticObservation` に「発生元（Passive/Active/Fuzzer/Manual/外部レポート）」と
  ルールId・版・品質を持たせる（現行RuleId/Titleを拡張）。
- 受動警告の原文（ZAPレポート）は runs/ の証跡として保存。観測はその参照を持つ。

## 5. 安全制御と証跡

- 追加通信ゼロを保証する仕組み: 受動ジョブの計画に sendRequest/spider 系を含めない
  （計画の再生成検査で強制。現行の計画一致検査を流用）。
- 警告は実影響未確認。報告（17）で受動由来であることを明示。

## 6. UI / CLI

- 診断ジョブ一覧に「受動（再送なし）」バッジ。警告一覧はルール品質でフィルタ可能。
- CLI: `scopepilot scan --passive`（19）。

## 7. 未解決事項（A1）

1. 取込HARの大量化時の受動待機時間の上限調整（現行の maxDuration クランプの見直し）
2. 手動プロキシ（03）での準リアルタイム受動（ZAPの逐次受動はプロキシ経由で自動。警告の
   引き取り方法を A1 で確認）
