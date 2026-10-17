# ScopePilot 0.12.0 配布版

ScopePilot本体はBSD-3-Clauseライセンスです。配布物に含まれる `LICENSE` に再配布条件と免責事項を記載しています。第三者コンポーネントのライセンスは `THIRD-PARTY-NOTICES.md` と各コンポーネントのLICENSE／NOTICEを参照してください。

配布スクリプトは、BSDライセンス、PlaywrightのライセンスとNOTICE、実際に組み込む.NETランタイムのライセンスと第三者通知の同梱を検査します。GPLのBurp用プロキシが混入している場合は配布物の生成を停止します。ランタイムのライセンス文書は `licenses/dotnet` に保存します。

Windows x64版とARM64版、それぞれのSetup.exeとポータブルZIPを提供します。両方とも自己完結型で、.NETランタイムの別途インストールは不要です。Windows 10 21H2以降 / Windows 11が必要です。SnapdragonなどのWindows on ARMでは `win-arm64`、Intel/AMDの64ビットPCでは `win-x64` を選択してください。Windowsの「設定」→「システム」→「バージョン情報」のシステムの種類で確認できます。

ARM64版のアプリ本体と.NETランタイムはARM64ネイティブです。ARM64用SetupはARM64 Windowsにのみ導入できます（セットアップ起動部分はInno Setupのx86プログラムで、Windowsの互換実行を使用します）。外部のNode.js、Codex、BurpはそれぞれのWindows on ARM対応と実行条件を確認してください。

## インストーラー（推奨）

1. PCに合う `ScopePilot-0.12.0-win-arm64-Setup.exe` または `ScopePilot-0.12.0-win-x64-Setup.exe` を実行します。利用者ごとの導入で管理者権限は不要です。
2. セットアップの説明を読み、必要ならデスクトップのショートカットを選択してインストールします。
3. `%LOCALAPPDATA%\Programs\ScopePilot` に導入され、スタートメニューに登録されます。
4. 完了画面から「初回セットアップガイド」を開き、外部ソフトとMCPの接続を設定します。

Node.js、Microsoft Edge、Codex CLI、Burp本体とBurp MCP拡張は別途準備が必要です。インストーラーは自動ダウンロード、ログイン、証明書登録、Codex設定変更を行いません。

現在の接続設定では `C:\Program Files\nodejs\node.exe`、`%LOCALAPPDATA%\OpenAI\Codex\bin` 配下の `codex.exe`、`%LOCALAPPDATA%\Programs\BurpSuite\jre\bin\java.exe` を使用します。詳しくは初回セットアップガイドを参照してください。

### 更新・ポータブル版からの移行

探索を終了し案件を保存してアプリを閉じ、新版のSetup.exeを実行します。既存のインストール先と案件を引き継ぎます。ポータブル版から初めて導入した場合は「MCP接続を設定」を実行してください。0.12.0は古い配置先の登録を検出して更新します。異なる配置先のアプリを同時に利用しないでください。

### アンインストール

Windowsの「設定」→「アプリ」からScopePilotを削除します。利用者が選択したプロジェクトフォルダー内の案件・実行履歴、Codexの設定・認証、外部ソフトは保持します。アンインストール後に不要となったMCP登録の削除は、他の作業への影響を確認したうえで利用者が行ってください。

## ポータブルZIPの初回起動

1. ZIPをローカルフォルダーへ展開します。ネットワーク共有上やZIP内から直接実行しないでください。
2. Node.js 24以降、Burp Suite Community Edition、Codex CLIを用意します。
3. Burp SuiteでProxy Listener `127.0.0.1:8080` とMCP Serverを有効にします。
4. `ScopePilot.exe` を起動し、「環境チェック」と「MCP接続を設定」を実行します。
5. Codexを再起動してから探索を開始します。

Playwright MCPランタイムは配布物へ同梱されます。Burp MCP用stdioプロキシは、Burp MCP拡張の抽出機能から別途取得して `%LOCALAPPDATA%\ScopePilot\mcp\mcp-proxy-all.jar` へ配置してください。別の場所を使う場合は、環境変数 `SCOPEPILOT_BURP_PROXY_JAR` に完全なパスを指定します。案件データは利用者が選択したプロジェクトフォルダーに保存します。起動時にプロジェクトフォルダーを開くか、新しいフォルダーと `.scopepilot.json` を作成してください。入力・編集内容は各画面の［保存］で手動保存します。旧案件は［旧案件を移行］からコピーできます。

## 配布物の検証

配布ファイルと同じ場所にある `.sha256` ファイルと、PowerShellの `Get-FileHash <配布ファイル> -Algorithm SHA256` の値が一致することを確認できます。

コード署名はまだ適用していません。組織内配布で署名が必要な場合は、署名証明書を用意した後に署名工程を追加してください。

## インストーラーの再生成

Playwright依存関係を `npm ci` で復元し、.NET 10 SDKとInno Setup 6.7.3以降を準備して実行します。

```powershell
./scripts/Build-Installer.ps1 -IsccPath 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
./scripts/Build-Installer.ps1 -Runtime win-arm64 -IsccPath 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
```

バージョンはcsprojから取得します。テスト、自己完結型publish、ZIP生成、Setup.exe生成、SHA-256生成を順に実行します。`-SkipPublish` は既に生成した同じ版・CPUの配布フォルダーを再利用し、`-SkipTests` は検証済みのCI工程に限って使用します。GitHub Actionsは両CPU向けにZIPとSetup.exeを成果物に含めます。ARM64・x64は同じプロジェクト形式とインストール先を使用し、同時に別のインストールとして登録しません。

非対話導入は `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOCLOSEAPPLICATIONS`、非対話削除はインストール先の `unins000.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART` を使用します。事前にアプリを終了してください。自動ログは一時フォルダーへ出力され、`/LOG="絶対パス"` でも指定できます。

インストーラー生成には [Inno Setup](https://jrsoftware.org/) を使用しています。


## ZAP連携

ZAP本体と対応Javaは別途導入し、アプリの［診断ツールへ］でJARとjava.exeを指定します。自動制御は保存済みHARのパッシブ診断です。[手順と保存方式](docs/PROJECTS-AND-HANDOFF.md)を参照してください。
