# 18 拡張と独自検査 概要設計

対応要件: 仕様書 F20、共通の UI–コア契約

## 1. 目的

製品内部の型付き契約、外部利用者向け API、独自検査ルールを別々の境界として提供する。BApp のバイナリ互換は対象外とし、移植可能なデータ契約と安全な実行モデルを提供する。

## 2. 契約層

`packages/contracts` は次を正本として持つ。

- コマンド、照会、進捗イベント、結果 DTO の JSON Schema。
- 外部 Product API の OpenAPI。OpenAPI から内部ドメイン型を直接公開しない。
- schema version と互換性規則。追加フィールドは許容し、必須項目の削除・意味変更は major 更新とする。
- TypeScript 型は schema から生成するか、生成差分を CI で検出する。手書きの二重定義を置かない。

Electron IPC は operation 名と request/response schema の許可リストを利用する。外部 Product API は既定無効、loopback 限定、起動ごとの bearer token、短い idle timeout を持つ。token はログ、URL、証拠へ出力しない。

## 3. 独自検査

`RulePackage` は manifest、入力 schema、判定規則、供給元、版、SHA-256、ライセンス、審査状態を持つ。初期実装は宣言的な要求テンプレートと判定だけを許す。

任意コードを伴う Script は後段とし、別プロセス、読み取り専用 package、作業用一時領域、CPU/メモリ/時間上限で実行する。ネットワーク要求は worker 自身から送らず、送信意図を core へ返し、[22](22-execution-control.md) の管理経路が実行する。OS ごとにこの隔離を保証できない場合、Script 機能を有効化しない。

外部ツールは `EngineAdapter` と同じ能力検証を通す。stdout/stderr、終了コード、生成ファイルを上限付きで取り込み、結果だけでなく失敗と未実施範囲も保存する。

## 4. 安全制御と証拠

- 変更系 API は有効な認可 ID、計画 ID、冪等性キーを必要とする。
- 読み取り API も案件単位で制限し、原本証拠と秘密値は既定で返さない。
- RulePackage の有効化、無効化、実行、権限拒否を監査イベントへ記録する。
- 拡張が必要な制約を強制できない場合は計画を拒否し、警告だけで続行しない。

## 5. UI / CLI

UI は契約版、拡張の供給元・版・審査状態・要求能力・最終実行を表示する。CLI は `scopepilot api serve` と `scopepilot rule list|validate|enable|disable` を提供する。API schema と生成済みクライアント例を配布物に含める。

## 6. A3 決定項目

1. Product API の最小 endpoint とイベント配送方式。
2. Windows/macOS 双方で保証できる Script worker の隔離方式。
3. RulePackage 署名を必須にする供給経路と、組織内 package の信頼登録手順。
