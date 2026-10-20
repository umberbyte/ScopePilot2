# 06 変換・差分・トークン解析（Decoder / Comparer / Sequencer相当） 概要設計

対応要件: 仕様書 F06（Decoder と Comparer）・F07（Sequencer相当）

## 1. 目的

URL・HTML・Base64・hex 等の変換（Decoder相当）、テキスト・バイナリの差分（Comparer相当）、
トークンの採取と統計解析（Sequencer相当）をローカルユーティリティとして提供する。
Decoder と Comparer は通信を発生させない。Sequencer の標本採取は対象通信を発生させる。

## 2. 共通部品

- 差分表示: 04（再送ワークベンチ）の DiffRenderer を共通部品化
- バイナリ取扱: EvidenceService からの範囲読込と証拠参照

## 3. コンポーネント構成

```text
CodecService（core の純関数集）:
  変換: URL encode/decode（部分指定可）・HTML entity・Base64/Base64URL・hex・
  hash表示(SHA-256/MD5は指紋確認用と明記)・日時/タイムスタンプ変換
  連続変換: 変換履歴をスタックで保持し、段階的に適用・巻き戻しできる
ComparerService（新規）:
  2入力（テキスト/バイナリ/通信2件）の行差分・バイト差分・長さ・類似度。
  通信指定の場合は Exchange（20）から本文を遅延読込
SequencerService（新規・A3）:
  採取: ログイン応答等からトークン（Cookie/hidden/bearer）をN回採取。
  採取は「採取専用の再送計画」として認可・上限の内側で実行（採取も通信を発生させる）
  解析: 文字別頻度・エントロピー・連長・既知乱数との比較・連続値の差分。
  「統計的に劣る」ことをもって脆弱と確定しない。標本数・制約・検定の前提を必ず表示
```

2026-10-20 時点の実収集経路は、許可済み `targetUrl` への逐次 GET と本文中の
`token=...`、名前を指定した応答 `Set-Cookie`、または名前を指定したHTML `hidden` inputからの抽出に限定する。`NodeSequencerTransport` が既定 2 RPS、応答 1 MiB 上限、
redirect 非追従で収集し、応答本文は抽出 callback の間だけ保持する。任意の認証roleを指定すると、
事前のlogin成功sessionから対象URLのdomain/pathへ適用可能なcookieだけを各収集requestへ付ける。
認証cookie値はtransport外へ出さず、結果・台帳には適用名だけを残す。応答cookie値も抽出 callback の間だけ扱い、
結果・台帳には抽出元とcookie名またはfield名だけを残す。hidden値も上限付き属性走査の間だけ扱う。bearerからの抽出、任意extractorを含む完全な採取専用再送計画は後続とし、現行経路と区別する。

## 4. データモデル

- 変換・差分は証跡モデルを持たない（UI上の作業）。差分の保存が必要な場合は
  診断観測のメモ（F19）へ結果テキストを添付できる。
- Sequencer の採取・解析結果は `runs/sequence-<時刻>/` に保存し、観測（実影響未確認）として記録。

## 5. 安全制御と証跡

- Codec/Comparer は通信を発生させないため制御対象外。Sequencer の採取のみ認可・上限の内側。
- Sequencer の対象が認証トークンの場合、値は画面でマスクし、解析用一時領域から保存しない。
  保存するのは keyed fingerprint、統計値、標本数、取得条件である。

## 6. UI

- 「ツール」領域に Decoder（連続変換パネル）・Comparer（2ペイン差分）・Sequencer（採取設定と
  統計表）を配置。任意の通信・任意の観測から「この要求を Decoder/Comparer へ」で直接渡せる。

## 7. 確定事項

1. Sequencerの初期解析は、標本数、欠損/重複率、byte/文字長の分布、alphabet、文字位置別頻度、
   Shannon entropy（symbol当たりとtoken当たり）、連長、隣接標本のHamming距離、連続値として解釈できる
   場合の差分・serial correlationとする。暗号学的乱数判定やBurp互換スコアは提供しない。固定文言は
   「この統計は採取条件下の偏りを示す補助情報であり、予測可能性や脆弱性を証明しません」とする。
2. バイナリ差分は各入力1 MiBまでを直接可視化する。超過時はhash、全長、先頭/末尾64 KiB、差分範囲の
   summaryを表示し、利用者が64 KiB単位のrangeを追加読込する。全体をrenderer memoryへ載せない。
3. 採取既定は100標本、最小30、通常上限10,000とする。開始前に残通信予算を確認し、100未満しか
   確保できない場合は可能数と統計制約を表示する。30未満では統計を生成せず採取記録だけを残す。
   adaptiveな自動追加採取は行わず、追加は子計画として別hashを持つ。
