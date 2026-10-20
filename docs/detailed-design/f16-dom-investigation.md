# F16 DOM 調査

## 1. 対象

DOM source/sink 観測、同値伝播、frame/shadow DOM の範囲、再現証跡を扱う。上位は `design/14`, `07`, `20`。

## 2. UI/CLI

- Simple: 結果レビューに候補、再現可否、制約を表示。
- Advanced: A04/A08 で source/sink、DOM path、trace、再現操作を確認。
- CLI: 保存済み observation の analyze/export。browser 操作は plan 経由。

## 3. モジュール

`DomSnapshot`, `DomObserver`, `ValueFlowCorrelator`, `FrameBoundaryPolicy`, `DomCandidateBuilder`, `DomEvidenceProjector`。top frame、許可 origin の child frame、open shadow root を対象とする。

## 4. 処理

入力値に run 固有 marker を付け、同じ値が source から sink へ現れた観測を相関する。コード意味解析だけで脆弱性を確定しない。closed shadow、cross-origin frame、browser extension context は coverage 外として記録する。

## 5. 安全・証跡

CSP や browser security setting を迂回しない。DOM snapshot は PII redaction policy を通し、元 screenshot/network exchange/action sequence と関連付ける。marker 自体が業務データを変更し得る操作は確認対象。

## 6. 失敗

page navigation で stale になった handle は再利用しない。相関が文字列部分一致だけの場合は confidence を下げる。instrumentation 注入不可は `CapabilityUnavailable` とし、未検出を安全判定にしない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F16-UT-001 | `core/test/unit/dom-investigation/value-flow.test.ts` | 同一 marker | source/sink candidate |
| F16-UT-002 | 同上 | 部分一致 | low confidence |
| F16-UT-003 | `frame-boundary-policy.test.ts` | cross-origin child | 観測対象外と記録 |
| F16-UT-004 | 同上 | open/closed shadow | open のみ対象 |
| F16-UT-005 | `dom-candidate-builder.test.ts` | observation なし | finding を作らない |
| F16-UT-006 | `dom-evidence.test.ts` | PII node | projection を redact |
| F16-UT-007 | `dom-observer-state.test.ts` | navigation 後 event | stale generation として隔離 |

## 8. 非単体テスト

Playwright init script と frame/shadow fixture の IT、CSP 有効ページで非迂回を FT、browser version ごとの capability probe を実施する。

## 9. 現行の実観測経路

- `live=true` を明示したAPI/UI操作だけが `PlaywrightDomObserver` を起動する。Coreで対象URLを案件scopeに
  照合した後、adapterもnavigation・redirect・subresourceを同じscopeで送信前検査する。WebSocketは遮断する。
- context init scriptをpage scriptより前に登録し、query/hash/referrer/cookie/input/storage/postMessageの
  文字列sourceと、`innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval` /
  文字列timer / `srcdoc`等のsinkを最大500event・各4096文字で一時観測する。CSPは変更しない。
- self-test済みかつscope内のframeだけを取り込み、cross-origin frameと `about:` / `data:` frameは対象外とする。
  open shadow root内は共有prototype hookで観測できるが、closed shadow rootは対象外である。
- Coreで同値相関した直後にmarkerをSHA-256 fingerprintへ置換し、実値やDOM text snapshotをAPI・証跡へ返さない。
  instrumentation/navigation失敗は `CapabilityUnavailable` とし、観測なしを安全判定にしない。
- 現行は初期ロードと250msの限定観測であり、操作sequence、認証session、長時間event、stack/CSS selector、
  screenshot/HAR/trace、worker、変形をまたぐtaint、完全なsink集合には未対応である。候補は脆弱性確定ではない。
