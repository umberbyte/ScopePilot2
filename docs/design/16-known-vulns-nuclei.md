# 16 既知脆弱性と構成（Nuclei統合） 概要設計

対応要件: 仕様書 F18・5.1（更新対象）・5.3（ルールの信頼性）

## 1. 目的

Nuclei による既知製品・脆弱性の実検査を診断パイプラインの構成要素として追加する。
CVE情報DBとの照合・優先付け情報は任意拡張（仕様書1.3）であり、代替完了条件に入れない。

## 2. 共通基盤

- [21](21-update-management.md) の runtime bundle で Nuclei とtemplate集合を固定する。
- [20](20-storage-evidence.md) のrun/evidenceと [17](17-organizer-reporting.md) の重複整理を使う。

## 3. コンポーネント構成

```text
NucleiAdapter（01のアダプター・任意導入）:
  実行: nucleiバイナリ（版固定）を次の制約で起動
    - 自動更新（-update/テンプレート自動取得）を無効化し、製品が固定したローカルテンプレート集合のみ使用
    - ターゲットは計画化された対象URL（許可Origin検査済み）のみ
    - 出力は JSONL（-jsonl）で runs/nuclei-<時刻>/ へ
  安全制限（5.3）: HTTP protocolだけを初期許可し、code/JavaScript/ローカルファイル参照/
    headless/workflow/DNS/network/SSL/WebSocket/OAST を静的構文検査とID allowlistで除外
  取込: 検出結果→DiagnosticObservation（区分=Nuclei・実影響未確認）。テンプレートID・版・
    マッチ箇所を記録
TemplateStore（21と共通）: 審査済みテンプレートID・ファイル集合の管理。署名検証＋
  補助ファイルを含む集合全体のSHA-256固定（テンプレート単体の署名にだけ依存しない）
```

## 4. データモデル

- `EngineRuntime`: 種別（ZAP/Nuclei/…）・版・取得元・SHA-256・互換条件（5.2手順3）。
- 照合情報（構成推定）: バナー・URL・ファイル名による推定は「候補」扱いとし、実検査結果と区別して
  表示（5.1）。ライブラリ同梱・影響版該当・到達性を分けて記録。

## 5. 安全制御と証跡

- Nuclei の実行には認可の許可操作区分 `NucleiScan`（[02](02-case-scope-authorization.md)）が必須。
- Nucleiの送信も案件の通信上限・速度制御の内側（22）。Nuclei は Delegated 経路であり、capability fixture で
  最大overshootを測定できない構成は有効化しない。
- 実行ごとに「使ったテンプレート集合のhash」を実行記録へ残し、再現性を保証。

## 6. UI / CLI

- 診断設定にNucleiトグル（既定オフ・任意導入）。結果はZAP警告と同じ一覧でエンジン列が「Nuclei」。
- CLI: `scopepilot scan --nuclei`。

## 7. 確定事項

1. 初期template集合はtop-level protocolが`http`だけで、審査済みtemplate ID allowlistに含まれるものに限定する。
   deny tagの初期集合は`dos,fuzz,intrusive,bruteforce,headless,code,network,file,dns,oast`とするが、tagは
   補助判定であり安全境界に使わない。YAML ASTをschema validationし、`code`、`javascript`、`headless`、
   `dns`、`network`、`file`、`ssl`、`websocket`、`flow`、workflow、外部payload/file参照、
   `interactsh-url`、未知の実行keyが一つでもあれば拒否する。展開後AST hashと採用ID一覧をbundleへ固定する。
2. 全上流集合を同梱しない。Stable bundleは審査済みsubsetだけを含み、上限は圧縮100 MiB、展開500 MiB、
   50,000 file、stage/verify 10分とする。超過は分割bundleにし、暗黙に上限を引き上げない。offline packは
   template、補助file、license/NOTICE、manifest、署名を含む正式な配布経路とする。
3. 共通表示は`Info|Low|Medium|High|Critical|Unknown`の順序だけを正規化し、engine原文severity、confidence、
   rule/template IDを保持する。Nucleiのseverityは同名へ、ZAP InformationalはInfoへ写す。engine間で意味が
   同じとは表示せず、finding重大度は人の確認後に別fieldで付ける。UnknownをInfoへ降格しない。

根拠: NucleiはHTTP以外にもDNS、TCP、SSL、JavaScript、Code等を扱うため、tag除外だけではなく構文能力を
denyする（[Nuclei公式repository](https://github.com/projectdiscovery/nuclei)）。engineとcommunity templateは
MIT licenseだが、使用版のlicense/NOTICEをbundleに同梱する（[nuclei-templates](https://github.com/projectdiscovery/nuclei-templates)）。
