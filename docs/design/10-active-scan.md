# 10 能動診断（自動実行） 概要設計

対応要件: 仕様書 F11・3.1 F11行（自動探索＋能動クロール→能動診断を既定で自動実行）

## 1. 目的

認可済み案件で、探索（07）＋能動クロール（ZAP Spider等）で対象面を広げたうえで、
ZAPのアクティブ診断を**既定で自動実行**し、所見まで自動で通す。A1 の中核。

## 2. 旧版から継承する知見

- ZAP の計画生成、runtime検証、実行、report取込を一つの run として追跡する。
- Explore は Safe、能動診断は認可済み standard session とする。
- 計画hash、入力HAR hash、add-on版、上書き拒否、取込時重複排除を回帰試験にする。

## 3. 方針の切り替え（現行からの差分）

| 現行 | 本実装 |
|---|---|
| 診断対象は観測済みHAR・採用済みURLのみ | 自動探索（07）の結果＋Spider（contextのincludePaths限定）で対象面を拡大。Spiderジョブは計画へ明記し承認証跡に残す |
| アクティブ診断は既定無効＋実行ごとにACTIVE入力 | 認可（02）が有効なら計画を既定で自動実行。承認証跡（authorization json）は自動実行でも必ず保存 |
| 強度Low既定・各上限は設定 | 既定は安全側を維持（Low・スレッド1〜2・100ms間隔・ルール上限分）。引き上げは計画に記録され計画hashで固定 |

## 4. コンポーネント構成

```text
ActiveScanJob（Orchestrator配下・ZapAdapterを利用）:
  計画: 対象（採用パターン＋Spider結果のURL）×許可Origin検査×上限（対象URL上限・通信数・時間）
        + Spiderジョブ（認可に ActiveCrawl があれば既定有効）
  実行: runtime probe → 計画hash検証 → ZAP Automation実行 → report取込
  停止: 429/5xx増加・認証切れ・ZAP停止・証拠保存失敗を検知して一時停止/終了（22）
  取込: 警告→DiagnosticObservation（実影響未確認）→所見候補の自動整理（17）
AutoPlanComposer（新規）: 案件の認可・スコープ・上限から「探索→受動→能動→報告」の
  連続計画を1本組み立てる（A0完了条件の「探索→能動診断→所見まで自動で通す」の本体）
```

- Spider が発見した URL は scope を再検査し、案件予算を消費するseed requestでZAP history/contextへ登録してから
  active scan 対象へ昇格する。登録に失敗した URL は `Unscannable` として記録し、直接 active scan へ
  渡さない。これにより `URL Does not Exist` を回避しつつ、未観測だった発見先も対象面に含める。

## 5. データモデル

- 実行記録（20）: 計画hash・認可Id・対象URL数・ルール・強度・しきい値・各上限・エンジン/アドオン版と
  SHA-256・停止理由。
- Spiderが発見したURLは観測（Source=Spider）として記録し、候補選定（ガイドライン根拠付き、[27](27-security-guidelines.md)）へ流す。

## 6. 安全制御と証跡

- activeScanジョブへ渡す対象URL・includePaths・scope を許可Origin と計画時・実行直前に一致検査する。これは ZAP への**入力**の検査であり、ZAP が実際に送る個々の通信は傍受・拒否しない（ZAP は Delegated。22§3）。ZAP 由来通信の範囲遵守は与えた context と当該版の実測挙動に依拠し、逸脱は message 増分照合で事後検知・停止する。保証範囲を能力表・報告へ開示する。
- 能動診断は攻撃リクエストを送る旨を UI・報告・証跡の 3 箇所で明示する。
- ルールの版は実行開始時に固定（21）。診断途中の更新なし。

## 7. UI / CLI

- 診断タブ: 自動計画のプレビュー（対象数・想定通信数・所要見立て）→実行→
  ジョブ/ルール単位の進行→結果。
- CLI: `scopepilot scan --active` / `scopepilot run`（全自動。19）。

## 8. 未解決事項（A0〜A1）

1. Spiderジョブの初期パラメータ（深度・同時・期限）と対象URL上限の調整
2. ZAP history/context への seed 登録方式と、登録失敗時の分類
3. 強度既定の維持確認と「Lowでは発火しないルールがある」注記の引き継ぎ
   （docs/detection-improvement-policy.md F1-1）
