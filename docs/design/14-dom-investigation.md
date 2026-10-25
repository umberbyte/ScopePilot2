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
  taint追跡は初期の「同じ値の文字列照合」に限定する。変形をまたぐ追跡は`Unsupported`として
    coverageへ残し、完全なtaint解析を提供すると表示しない
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

## 7. 確定事項

1. 初期対象はtop frame、許可origin内のchild frame、open shadow rootとする。許可origin外frameはURLと
   境界だけを記録しDOMへ注入しない。closed shadow root、dedicated/shared/service worker、browser extension
   worldは初期範囲外とし、coverageへ`Unsupported`を残す。動的に追加されたframeにも同じorigin判定を適用する。
2. Playwrightのcontext init scriptでpage scriptより前に計測を登録し、対象のCSPを変更・無効化しない。
   strict CSP、Trusted Types、sandboxed frame等でhookのself-test eventを観測できない場合は
   `InstrumentationUnavailable`とし、DOM所見を生成しない。CSP回避を自動で試みず、未観測範囲として表示する。
3. 初期sourceはURL/location/hash/search、referrer、cookie、storage、postMessage、form/input valueとする。
   sinkは次のpriorityを持つ。

   - High-priority review: `eval`、`Function`、文字列`setTimeout/setInterval`、script URL/`srcdoc`。
   - Medium-priority review: `innerHTML`、`outerHTML`、`insertAdjacentHTML`、HTML属性setter、navigation URL。
   - Context-required: `postMessage` receiver、storageからの表示、DOM write。

   これはfinding重大度ではなく確認順である。同一値のsource→sink到達、stack、sanitizer有無をsignalとして
   重複排除し、値一致だけ、sink出現だけ、静的code文字列だけでは所見を確定しない。

## 8. 現行の実観測経路

- 明示的なlive操作でPlaywrightのcontext init scriptを登録し、scope内navigation/subresource/frameだけを
  最大500event・初期ロード後250msの範囲で観測する。scope外requestは送信前abortし、WebSocketを遮断する。
- source/sinkの文字列は相関中だけ保持し、返却候補ではSHA-256 fingerprintへ置換する。DOM text snapshotは
  初期経路では収集しない。CSP変更、closed shadow、cross-origin/data frame、workerは対象外である。
- live操作では任意の認証roleを指定できる。事前のlogin成功sessionから対象URLへ適用可能なcookieだけを
  観測専用browser contextへ渡し、cookie値は応答・監査へ残さない。roleなしの非認証観測も維持する。
- 現行は同一文字列と部分一致の候補化までで、操作sequence、stack、selector、screenshot/HAR/trace、
  session更新、長時間観測、変形追跡を含むDOM Invader相当のtaint engineではない。
