# MarkdownからWordレポートへの変換

## 操作

［診断所見］で［MarkdownをWordへ変換］を押し、UTF-8の `.md` / `.markdown` ファイルを選びます。［日本語Markdownを出力］で生成したレポートも選択できます。
変換後は［Wordを開く］で出力文書を開けます。Wordが未インストールでも変換できます。

外部のMarkdownはプロジェクトの `inputs/markdown-report-<ID>/` へ原本をコピーします。対応するローカル画像も相対パスを保持してコピーします。
プロジェクト内のMarkdownを選んだ場合はそのファイルを参照します。
出力先は `reports/word-<日時>-<ID>/` です。元のMarkdownや既存Word文書を上書きしません。

`word-conversion.json` に入力・出力のプロジェクト内相対パス、SHA-256、使用書式ID、画像参照、変換時の注意を記録します。
プロジェクトファイルの自動保存は行いません。レポート原本と生成物はプロジェクトフォルダーのバックアップに含まれます。

## 初期書式と対応範囲

- A4縦、余白25.4mm、日本語は游ゴシック、本文11pt
- 黒のタイトル・見出し、ページ番号
- 見出し、段落、強調、取消線、箇条書き、番号付きリスト、チェックリスト、引用、コード
- Markdownの表は編集可能なWord表として出力し、複数ページでは見出し行を繰り返す
- HTTP/HTTPS/mailtoのリンク、見出しへの内部リンク
- プロジェクト内のPNG/JPEG/GIF/BMP画像、または外部Markdownと同じフォルダー以下にある画像

Markdownは10MBまで、画像は1枚10MB・5千万画素までです。外部画像をネットワークから取得しません。
未対応・欠落画像は代替テキストを文書に残し、画面・ログ・変換記録に注意を表示します。
HTMLの `<br>` は改行に変換します。それ以外のHTMLは実行せずテキストとして掲載します。Mermaidなどの独自コードはコードのままです。
Markdownの文章・評価・状態を変換処理で書き換えません。番号付きリストはWordの番号機能へ変換します。

## テンプレートを反映するための構成

Markdown解析と文書組み立ては `MarkdownWordReportService` / `MarkdownWordRenderer`、書式は `IWordReportTemplate` / `DefaultWordReportTemplate` に分かれています。

`IWordReportTemplate` は書式ID、本文幅、スタイルIDの対応表、文書初期化を提供します。将来のテンプレートでは、この初期化でDOCX/DOTXのスタイル・余白・ヘッダー・フッターを適用できます。
コンバーターへ別の `IWordReportTemplate` を渡すことで、Markdown解析・本文生成を変更せず書式を交換できます。
今回は既定書式だけを画面で使用します。テンプレートファイル選択や、任意の表紙・本文差込位置の指定は後の追加対象です。

## 生成・確認

アプリはMarkdig 1.4.0とOpen XML SDK 3.5.1でローカル生成し、WordやPythonの起動を必要としません。
ライセンスはMarkdigがBSD-2-Clause、Open XML SDKがMITです。配布物に原文を同梱します。
