# GO-20 実行環境設定

## 対象・設計

- AGENTS.md を最初に確認。変更対象は Desktop の設定・runtime-tools と対応テスト。
- この作業ブランチには design/40・41 が未収録のため、ローカル `umberbyte/advanced-mode-redesign` の `docs/design/40-advanced-mode-redesign.md` と `umberbyte/spec-gap-resolution` の `docs/design/41-spec-gap-resolution.md` を `git show` で参照した。
- design/40 A90 とオーナー決定 Q7 に従い、既存 SettingsScreen に同一の設定コンポーネントを組み込み、Simple の独立 runtime-settings ウィンドウも維持。ナビゲーション全体の A90 への再編は他タスクの担当とし、この変更では既存 settings route の受け口に統合した。
- design/41 の unavailable/fixture 誤認防止に従い、未設定・確認失敗を成功表示せず、起動中の能力表と保存済み設定の確認を区別する。

## 実装

- runtime-tools.json の既存 schemaVersion 2 に任意の environment セクションを追加。旧設定は空の environment として読み込み、パス・AI選択・起動方式の互換性を維持。
- 保存項目は API ポート、ZAP API Origin、OAST HTTPS Origin、Interactsh 設定ファイルの絶対パス。任意の環境変数や秘密値を保存する機能にはしない。設定ファイルの内容も複写しない。
- 保存値を起動時環境変数へ重ね、空欄は継承。ZAP/Nuclei/manifest のパスは保存値、起動時環境変数、PATH/既知位置の順に解決する。Nuclei の disable 指定は維持する。
- API ポートを実際の server.listen に配線（127.0.0.1 固定、0 は自動割当）。エンジン・接続先・ポートは次回起動から反映し、現在の診断を変更しない。
- 入力検証：ポート範囲、HTTP(S) Origin、URL内の認証情報・query・fragment・path の拒否、OAST HTTPS、Interactsh 絶対パス・読取可能性・OASTとの組合せ。
- 保存して画面を維持するボタンを追加。未保存入力がある間は接続テストを無効にし、編集後は古い結果を消去する。
- 接続テストは trusted main/settings renderer から IPC 経由で main に依頼する。ZAP API の version、Nuclei の -version（shellなし・5秒・出力上限）、既存 NucleiRunner による manifest/hash/HTTP-only 検証、OAST の HTTPS HEAD と設定ファイル読取を個別表示。子プロセスの出力・設定内容を UI に返さない。
- テストで診断・daemon起動・OAST payload登録は行わない。OASTのCLI認証とcallback相関は未確認と明示。ZAP API接続先未指定時は自動構成とし、固定8080へ誤って接続せず、起動中の能力表へ案内する。

## 検証

- `npm ci --ignore-scripts` で作業ツリーに依存を導入。Electron の既定 installer を実行してアプリテスト環境を用意。依存定義・lockfile の変更なし。
- `npm run typecheck` 成功。
- Desktop unit suite 成功、47件（precedence/disable/失敗時非露出テストを含む最終全体実行）。
- `node --test apps/desktop/test/unit/runtime-connections.test.ts packages/adapters/test/engine-config.test.ts` 成功、10件。
- `npm run build --workspace @scopepilot2/desktop` 成功。
- Desktop で `npx playwright test test/app/runtime-settings.spec.ts` 成功、2件。独立ウィンドウ、ダークテーマ、入力エラー、JSON保存、接続失敗/未設定の表示、Advancedからの同一設定編集・ウィンドウ維持を確認。設定保存先は一時ディレクトリへ隔離。
- `git diff --check` 成功。

## 範囲と制限

- 実 ZAP/Nuclei/OAST 設備を使う診断や検出率ベンチマークは実施していない。接続成功の単体確認は所有ローカルHTTP serverと版固定テンプレートfixtureを使用。
- runtime bundle 更新・rollback、全体ナビ再編、所見・認証機能の変更は含めない。
- 作業途中に別所有の `apps/cli/src/main.ts` の変更が現れたため、コミット対象から除外した。
- ローカルコミットのみ。push・PR作成・Linear参照/更新は実施しない。
