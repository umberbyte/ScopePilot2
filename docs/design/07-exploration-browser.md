# 07 自動探索・ブラウザ 概要設計

対応要件: 仕様書 F08・3.1（認証・フォーム操作・状態遷移を含む自動探索）

## 1. 目的

独立プロファイルのブラウザで、認証・フォーム送信・状態遷移を含む自動探索を行い、
能動診断の対象面を広げる。許可範囲と禁止操作は適用する。AI は任意支援（7章）。

## 2. 旧版から継承する知見

- リンク、robots、sitemap、SPA遷移を同じ巡回ポリシーで正規化し、loop と上限を管理する。
- 認証や CAPTCHA で止まった場合は介入要求を永続化し、明示的に再開する。
- 観測を代表URLパターンへ集約し、AIへ渡す量を制限する。
- 文書由来の開始点と優先度は [25](25-document-hints-ai.md) の未確認 hint として扱う。

## 3. 方針の切り替え（現行からの差分）

| 現行 | 本実装 |
|---|---|
| フォーム送信は既定無効・無害な仮値1回 | 認可の許可操作区分（FormSubmit）の内側で、フォーム種別ごとの送信戦略（検索系=代表値、認証系=認証情報（08）、更新系=事前合意時のみ）を適用。禁止語彙・パス・禁止操作リストとの照合を送信前に行う |
| 認証は人が探索ブラウザへ直接ログイン | 自動ログイン（08）を標準とし、SSO/MFAなど自動化できない範囲だけ永続化した介入要求へ切り替える |
| 巡回はGET中心 | 状態遷移（詳細→一覧、ページャ、タブ）の自動追跡。探索深度・ページ数・通信数は案件上限の内側 |
| 観測のみ | 探索結果を能動診断（10）へ直接接続。探索→採用→診断を Orchestrator の自動計画へ |

## 4. コンポーネント構成

```text
BrowserAdapter（01）: TypeScript から Playwright を呼び、context分離・記録（HAR/trace/スクリーンショット）
ExplorationPlanner: 開始点（StartUrl+採用済みdocument hints）・探索戦略・上限から探索ジョブを計画
FormSubmitPolicy: フォーム種別判定と送信値の供給（代表値・辞書は05のPayloadSet管理と共通化）
  ※ 探索での送信値は入力例・代表値に限り、攻撃ペイロードは使わない（攻撃は診断ジョブの担当）
InterventionFlow: 認証・CAPTCHA等で止まったら介入要求→人が操作→再開
AiExplorationAssist（任意）: AI画面探索を「代表パターン確認」として計画へ差し込める
TriagePolicy/CandidateSelector（[27](27-security-guidelines.md)）: 観測を分類し、ガイドライン根拠つきで
  診断候補へ選定。SelectionGuidance（運用要約）は探索前の提示とAI入力（25）に使う
```

## 5. データモデル

- 観測に「探索経路」（どのページのどの操作から到達したか）を
  記録し、サイトマップ（03）と診断時計の文脈（操作列）に使う。
- 探索ジョブの記録: 探索戦略・送信したフォーム数と内訳・停止理由・未到達の記録。

## 6. 安全制御と証跡

- すべての巡回・送信は許可Origin・通信数・ページ数・実行時間の内側。禁止語彙検査と警告表示。
- アップロードフォーム・削除系操作は認可の許可操作区分で明示的に許可された場合のみ。
- HAR・trace・スクリーンショットの原本は暗号化し、画面と共有 export にはマスク済み派生物を使う（20）。

## 7. UI / CLI

- Simpleは固定済み探索strategyの進行と介入要求を表示し、完了後に代表パターンの採用/除外だけを許す。
  Advancedは操作者権限の範囲で開始点、深度、action/page上限、form方針、AI提案を編集できる。
  どちらも同じExplorationPlanを作り、modeをengine挙動へ渡さない。
- 探索画面: 進行状況・介入要求・探索経路ビュー・観測の代表パターン一覧。
- CLI: `scopepilot explore`（19）。

## 8. 確定事項

1. フォーム分類は `Search`、`Authentication`、`Mutation`、`Upload`、`Unknown` の5種とし、action/method、
   input type/name/autocomplete、button label、既知の認証routeを決定論的ruleで評価する。SearchはGET/HEADと
   代表値1件、Authenticationは[08](08-authentication-session.md)の定義、Mutationは`FormSubmit`と
   operation個別allowlist、Uploadはさらに`Upload`と明示fixtureを要求する。複数分類またはUnknownは
   自動送信せず介入要求へ送る。分類のconfidenceは表示するが、AIの推定だけで送信可へ昇格しない。
2. 状態遷移の既定深度は5、同一状態からのactionは50、1 role当たり500 pageとする（案件上限が小さければ
   そちらを優先）。loop keyは正規化URL、role、DOM action signature、Cookie/storageのkeyed fingerprintを
   組み合わせ、同じkeyの3回目の到達を展開しない。SPAのURL不変遷移もDOM action signatureで区別する。
3. 全操作に `actorKind=CoreAutomation|UserIntervention|AiProposal`、`executedBy=BrowserAdapter|User`、role ID、
   session ID、親action IDを記録する。AIは候補を提案できるだけで、実送信者は常にBrowserAdapterまたは
   Userとして別フィールドに残す。画面・証拠・報告で「AIが実行した」と省略表示しない。
