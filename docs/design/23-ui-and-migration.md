# 23 UI・移行 概要設計

対応要件: 仕様書 8章、6.5、Windows/macOS 配布

## 1. 目的

Electron renderer に React/TypeScript のデスクトップ UI を実装し、案件、通信、診断、所見を同じ文脈で移動できるようにする。旧 WPF 画面の移植ではなく、[18](18-extension-api.md) の契約を利用する新規 UI とする。

## 2. 画面構成

```text
案件: 案件、scope、認可、role、runtime bundle
ブラウザと通信: 探索、proxy session、通信履歴、site map、API、介入要求
要求ツール: Repeater、Fuzzer、Decoder、Comparer、Sequencer
診断: plan preview、認可との対応、job progress、停止理由、engine logs
所見と証拠: observation、finding、確認状態、重複 group、coverage、evidence
報告: 条件、実施/未実施範囲、export preview
設定: engine、certificate、secret、update、extension
```

画面上部に現在の案件、role、対象 scope、認可状態、実行状態を常時表示する。送信操作の直前には対象、操作区分、想定通信数、共有上限への影響を同じ位置で確認できる。

## 3. 大量データ

通信表は row virtualization と server-side cursor pagination を使い、初期取得に本文を含めない。選択行の本文、diff、screenshot を遅延読込し、読み込み中・打切り・取得失敗を区別する。filter/sort は DB query へ渡し、renderer で10万件を保持・並べ替えない。

長い処理は progress event を購読し、renderer の再読み込み後も run ID から復元する。UI の破棄でジョブを止めず、停止は明示 command として扱う。

## 4. Electron の境界

renderer は local packaged content だけを表示する。対象サイトは Playwright の独立 browser profile で開き、Electron の BrowserWindow/WebView に読み込まない。外部 link は allowlist と利用者操作を経て OS browser へ渡す。

preload API は機能別に限定し、入力を schema validation する。HTML、Markdown、engine message、対象 response は untrusted data として sanitize し、CSP で inline script と任意 network を禁止する。DevTools と debug endpoint は production で既定無効とする。

## 5. 秘密値と誤解防止

秘密値は既定マスクとし、原本表示は再認証または OS session の確認、目的入力、audit event を要求する。コピーと export は表示とは別権限にする。

観測の source と状態を badge だけに頼らず文言で示す: `文書の記載・未確認`、`通信で観測`、`エンジン検出・実影響未確認`、`人が確認済み`。0件の場合も未実施、失敗、対象外、検出なしを分ける。

## 6. 移行

ScopePilot2 に旧 C#/WPF コードは持ち込まない。移行対象は案件データと利用者 workflow である。

- 旧案件 import は read-only の one-way tool とし、変換前後の件数、欠落、警告、hash を report する。
- Burp project の直接 import は完成条件に含めない。HAR、JSON、CSV、Markdown、`.http` など公開形式を対象にする。
- 旧版の画面名や ViewModel 構造を新 UI の API に反映しない。
- Windows を A0/A1 の主検証環境とし、macOS は同じ契約・シナリオを配布前に通す。機能差は capability として表示する。

## 7. アクセシビリティと状態保存

キーボード操作、focus、screen reader label、拡大、light/dark theme を共通 component の受け入れ条件にする。window size や column 設定は利用者設定として保存するが、secret や対象 response は UI state に入れない。

## 8. 受け入れ条件

1. 10万件 fixture で scroll、filter、本文表示中に UI が操作可能である。
2. renderer compromise を想定しても、汎用 fs/process/network API に到達できない。
3. desktop と CLI が同じ計画と結果 schema を扱う。
4. Windows/macOS で同じ必須 workflow を通し、OS 差を文書化する。
5. observation、finding、document hint、未実施範囲が視覚・読み上げの両方で区別される。
