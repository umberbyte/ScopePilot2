# 14 DOM調査 概要設計

対応要件: 仕様書 F16（DOM 調査）

## 1. 目的

DOM の入力元（source）と危険な出力先（sink）を調査し、ブラウザ上の証拠として残す。
DOM Invader と同一能力は前提にしない（仕様書121行目の難所の一つ）。A3。

## 2. 共通基盤

- [07](07-exploration-browser.md) の TypeScript PlaywrightAdapter と独立 BrowserContext を使う。
- HAR、trace、画面操作、ZAP履歴を run ID と request ID で対応付ける。

## 3. コンポーネント構成

```text
DomInstrumentation（BrowserAdapter配下）:
  注入: 記録ブラウザの各ページへ計測スクリプトを注入（init script）。
    監視対象: location/hash/documentURI/document.cookie/referrer 等の入力源、
    innerHTML/outerHTML/insertAdjacentHTML/eval/Function/setTimeout(文字列)/
    postMessageハンドラ/属性setter 等の主な sink
  記録: source→sink のデータフロー（値の断片・スタック・要素のCSSセレクタ）をイベント列として記録
  taint追跡は段階導入: 初期は「同じ値の文字列照合」で source/sink を結び付け、
    変形をまたぐ追跡は後段（完全なtaint解析を約束しない）
DomReportJob: 記録したフローを診断観測（区分=DOM調査・実影響未確認）として整理。
  手動確認（ブラウザでの再現）への導線を添える
```

- 診断ペイロードの注入送信（05）と組み合わせる場合も、注入は BrowserAdapter 経由で
  認可・上限の内側。

## 4. データモデル

- `DomFlow`: ページURL・source種別・値の keyed fingerprint・sink種別・要素セレクタ・
  スタック要約・スクリーンショット参照。
- 証跡: 記録セッションのHAR・trace・スクリーンショット（runs/ 内）。

## 5. 安全制御と証跡

- 計測は対象ページ内のみ（拡張機能の一般インストールはしない）。DOM値は一致判定に必要な
  最短時間だけ保持し、証拠には既定で値そのものではなく keyed fingerprint と型・長さを残す。
- 証拠（スクリーンショット・DOM断片）の共有エクスポートはマスク済み派生物のみ（6.3）。

## 6. UI

- 「DOM調査」ペイン: ページごとの source/sink 一覧とフロー図（単純なリスト＋対応線）。
  フローを選ぶと該当要素のスクリーンショットと記録通信を表示。

## 7. 未解決事項（A3）

1. 注入スクリプトの対象フレーム（iframe・shadow DOM・worker）の初期範囲
2. CSP の strict 環境での注入可否と、注入できない場合の表示
3. source/sink の初期辞書（重大度の付け方）と誤検出の抑制
