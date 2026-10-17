# 10 能動診断（自動実行） 概要設計

対応要件: 仕様書 F11・3.1 F11行（自動探索＋能動クロール→能動診断を既定で自動実行）

## 1. 目的

認可済み案件で、探索（07）＋能動クロール（ZAP Spider等）で対象面を広げたうえで、
ZAPのアクティブ診断を**既定で自動実行**し、所見まで自動で通す。A1 の中核。

## 2. 再利用する現行資産

- `Services/ZapHandoffService` / `ZapCliRunner` / `ZapAddonService` / `ZapResultImporter`:
  計画生成（HAR取込→受動待機→対象URLごとのactiveScanジョブ→レポート）、実行・検証・取込の全体
- `Services/ManagedZapProxy`（探索プロキシ）と `ExplorationProxySession`
- 実績: シミュレーション（docs/SIMULATION-GUIDE.md）で 探索→採用→ZAP→取込 のヘッドレス完走済み

## 3. 方針の切り替え（現行からの差分）

| 現行 | 本実装 |
|---|---|
| 診断対象は観測済みHAR・採用済みURLのみ | 自動探索（07）の結果＋Spider（contextのincludePaths限定）で対象面を拡大。Spiderジョブは計画へ明記し承認証跡に残す |
| アクティブ診断は既定無効＋実行ごとにACTIVE入力 | 認可（02）が有効なら計画を既定で自動実行。承認証跡（authorization json）は自動実行でも必ず保存 |
| 強度Low既定・各上限は設定 | 既定は安全側を維持（Low・スレッド1〜2・100ms間隔・ルール上限分）。引き上げは計画に記録され計画hashで固定 |

## 4. コンポーネント構成

```text
ActiveScanJob（Orchestrator配下・ZapHandoffServiceを内包）:
  計画: 対象（採用パターン＋Spider結果のURL）×許可Origin検査×上限（対象URL上限・通信数・時間）
        + Spiderジョブ（オプション・既定有効はA1で確定）
  実行: -autocheck → -autorun（現行どおり計画hash検証・アドオン版固定・上書き拒否）
  停止: 429/5xx増加・認証切れ・ZAP停止・証拠保存失敗を検知して一時停止/終了（22）
  取込: 警告→DiagnosticObservation（実影響未確認）→所見候補の自動整理（17）
AutoPlanComposer（新規）: 案件の認可・スコープ・上限から「探索→受動→能動→報告」の
  連続計画を1本組み立てる（A0完了条件の「探索→能動診断→所見まで自動で通す」の本体）
```

- 既知の失敗扱い（取込HARに無いURLで `URL Does not Exist` 中断）は、Spider結果とHAR対象の
  差分を計画生成時に検査し、HARに存在しないURLをジョブへ含めないことで回避する。

## 5. データモデル

- 実行記録（20）: 計画hash・認可Id・対象URL数・ルール・強度・しきい値・各上限・エンジン/アドオン版と
  SHA-256（現行 zap-environment.json を一般化）・停止理由。
- Spiderが発見したURLは観測（Source=Spider）として記録し、候補選定（ガイドライン根拠付き）へ流す。

## 6. 安全制御と証跡

- activeScanジョブの対象URLは許可Origin・includePathsと一致検査（現行の二重検査を維持）。
- 能動診断は攻撃リクエストを送る旨をUI・報告・証跡の3箇所で明示（現行README記述を引き継ぎ）。
- ルールの版は実行開始時に固定（21）。診断途中の更新なし。

## 7. UI / CLI

- 診断タブ: 自動計画のプレビュー（対象数・想定通信数・所要見立て）→実行→進行（現行の
  ジョブ/ルール単位のライブ表示を維持）→結果。
- CLI: `scopepilot scan --active` / `scopepilot run`（全自動。19）。

## 8. 未解決事項（A0〜A1）

1. Spiderジョブの初期パラメータ（深度・同時・期限）と対象URL上限の調整
2. AutoPlanComposer の計画形式（現行 engagement.json の拡張 vs 新形式）
3. 強度既定の維持確認と「Lowでは発火しないルールがある」注記の引き継ぎ
   （docs/detection-improvement-policy.md F1-1）
