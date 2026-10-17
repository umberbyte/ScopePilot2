# 01 共通アーキテクチャ 概要設計

対応要件: 仕様書2章（構成の選択）・4章（共通アーキテクチャとOS対応）・2.2（系列A/B分離）

## 1. 目的

Burp Suite Professional 代替（系列A: Windows/WPF先行）と3OS展開（系列B: Avalonia）の共通土台を定める。
本リポジトリ（ScopePilot2）は系列Aの実装本体であり、系列Bは同じ Domain/Services を移植して使う。

## 2. 再利用する現行資産

ScopePilot（初回コミット 763b416 として複製済み）から次をそのまま使い、WPF依存だけを分離する。

| 層 | 資産 | 使い方 |
|---|---|---|
| Domain | `Models.cs`（案件・ロール・観測・候補・所見・ガイドライン）、`DiagnosticModels.cs`、`ApiModels.cs`、`DocumentHints.cs`、`AppSettings.cs` | そのまま拡張。OS非依存を維持 |
| Infrastructure | `ObservableObject` / `RelayCommand` | そのまま（UI非依存） |
| Services | 探索（`FastCrawlerRunner`、`ExplorationPackageBuilder`、`AiInputBuilder`）、ZAP（`ZapHandoffService`、`ZapCliRunner`、`ZapAddonService`、`ZapProxyApi`、`ManagedZapProxy`、`ZapResultImporter`）、AI（`ApiDocumentAiRunner`、`ZcodeExplorationRunner`、`DocumentHintRunner`）、証跡（`ProjectPaths`、`ProjectStore`、`RunHistoryService`）、報告（`FindingReportService`、`JapaneseDiagnosticReportService`） | アダプター化は最小限（後述）。「ViewModelからWPF APIを直接参照しない」規則（4.3）を新規コードに適用 |
| tools | `fast-crawl.js`、`crawl-policy.js`、`mcp-tool-filter.js`、`zap-browser-record.js`、`playwright-runtime` | そのまま |

## 3. コンポーネント構成（目標形）

```text
ScopePilot2 (Windows/WPF)                [系列B: Avalonia UI]
  ViewModels（WPF非依存を維持）
  Application 層: JobOrchestrator（実行計画） / AuthorizationService（認可）
  Services:
    ZAPアダプター: ZapEngineAdapter（既存ZapHandoffService/ZapCliRunnerを集約）
    Browserアダプター: PlaywrightWorker（現行toolsをそのまま）
    Nucleiアダプター: NucleiAdapter（A2新規・任意導入）
    OASTアダプター: OastAdapter（A3新規）
  Platform Services（抽象）: ISecretStore / IProcessTree / IFileDialog / IThemeService
  保存: EvidenceStore（SQLite索引＋ファイル原本、20-storage-evidence.md）
  Update: UpdateManager（21-update-management.md）
```

- 既存Servicesは「EngineAdapter」インターフェースの背後に段階的に置く。アダプター境界は
  `IEngineCapability`（能力問合せ: 再送可否・モード・ジョブ種別）と `IEngineSession`（起動・停止・実行）の2つに絞る。
- エンジンの能力は実行前に問い合わせ、未対応操作は拒否する（仕様書4.1）。別エンジンへの暗黙切替はしない。
- 内部連携はloopback HTTP（ZAP API）と子プロセス（node/java/nuclei）のみ。新規のIPCは作らない。

## 4. 段階との対応

- A0: `JobOrchestrator` の骨組み（計画オブジェクト＝現行runs/*-engagement.jsonの拡張）と
  `scripts/simulation` ハーネス（実績あり）を CLI (19) へ接続。
- A1: 認可モデル（02）と自動実行（10）を Orchestrator 配下へ。
- B0以降: Platform Services の差し替えとUI移植。系列Aのコードは ViewModel から
  `System.Windows` を参照させない規則で審査する（CIでチェック可能: 禁止名前空間のgrep）。

## 5. 安全制御と証跡

- すべての送信系機能は `JobOrchestrator` が生成した計画（対象・上限・認可参照・計画hash）を通して実行する。
  直接エンジンを呼ぶ経路は Orchestrator の内部に限定する。
- 証跡の所在は現行踏襲: `runs/<時刻>-<id>/`（engagement.json・ログ・HAR・計画・承認証跡）。

## 6. 未解決事項（A0）

1. `IEngineCapability` の初期スキーマ（ZAP: sendRequest/spider/requestor/activeScan/oast/WebSocket の可否表）
2. Orchestrator の計画オブジェクトと現行 engagement.json の統合形式
3. ViewModel の WPF 参照チェックのCI組み込み方法
