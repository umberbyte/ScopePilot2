# F15 HTTP/2・高度通信

## 1. 対象

HTTP/2 semantic request、stream metadata、ALPN、protocol limitation を扱う。HTTP/3 は初期版 `Unsupported`。上位は `design/13`, `21`, `22`。

## 2. UI/CLI

- Simple: transport 表示と limitation のみ。
- Advanced: A06/A08 で pseudo-header、通常 header、body、transport option を分離表示。
- CLI: `transport capabilities` と承認済み H2 send。

## 3. モジュール

`Http2RequestModel`, `PseudoHeaderPolicy`, `HeaderPolicy`, `TransportPlan`, `NodeHttp2Adapter`, `TransportCapabilityProbe`。wire byte 編集ではなく semantic field を扱う。

## 4. 処理

`:method`, `:scheme`, `:authority`, `:path` の順序・重複を検証し、connection option と request を分離する。adapter は negotiated protocol、stream ID、settings summary、timing を返す。HTTP/1.1 への fallback は明示 option の場合だけ許可し証跡化する。

## 5. 安全・証跡

送信前 EgressPolicy は semantic target を使う。header injection、authority/scope 不一致を拒否する。Node runtime version と ALPN 結果を保存し、protocol を推測で成功表示しない。

## 6. 失敗

ALPN 不成立、GOAWAY、RST_STREAM、timeout を別 code で保持する。HTTP/3、raw frame injection、connection coalescing 攻撃は初期版で公開しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F15-UT-001 | `core/test/unit/advanced-transport/pseudo-header-policy.test.ts` | 重複/順序不正 | validation error |
| F15-UT-002 | 同上 | authority が scope 外 | `OutOfScope` |
| F15-UT-003 | `header-policy.test.ts` | CRLF 注入 | 拒否 |
| F15-UT-004 | `transport-plan.test.ts` | fallback 未許可 | H1 へ暗黙 fallback しない |
| F15-UT-005 | `transport-result.test.ts` | GOAWAY | response 成功と区別 |
| F15-UT-006 | `capability-policy.test.ts` | HTTP/3 | `Unsupported` |
| F15-UT-007 | `transport-evidence.test.ts` | negotiation 結果 | runtime/ALPN を保持 |

## 8. 非単体テスト

Node HTTP/2 adapter と TLS/ALPN server の IT、Windows/macOS runtime matrix、ZAP と Node 経路の表示差を fixture で検証する。

## 9. 現行の実プローブ経路

- `NodeHttp2Transport` は Core で案件 scope を確認した canonical HTTP(S) URL に、本文を保持しない
  bounded `GET` を送る。平文は h2c prior knowledge、TLS は `h2` / `http/1.1` の ALPN negotiation を使う。
- HTTP/2 response header を実際に受信した場合だけ h2 成功とする。response は 1 MiB、処理時間は30秒を上限とし、
  redirect は追従しない。GOAWAY、stream/session error、timeout、接続失敗を成功として補完しない。
- HTTP/1.1 request は利用者が fallback を明示許可した場合だけ別requestとして送る。未許可時はh2不成立を
  `CapabilityUnavailable` とし、H1へ暗黙再送しない。結果にはNode runtimeと実測ALPN（平文は `h2c` marker）を残す。
- `requested=http/1.1` の明示選択はfallbackではないため、H2 probe/prefaceを送らずbounded H1 requestを1回送る。
  この結果は `downgraded=false` とし、TLSでは実ALPN、平文では `http/1.1 (cleartext)` markerを残す。
  省略時は `requested=h2` と同じである。
- 所有TLS fixtureは実行時生成のlocalhost証明書を明示trust anchorとしてadapterへ渡し、ALPN `h2`、
  明示 `http/1.1`、H1-only peerのfallback許可/未許可を常時ITで検証する。trust anchor未指定時は
  自己署名証明書を拒否し、fixtureのために証明書検証を無効化しない。
- 現行UI/APIは capability probe に限定する。任意method/body/header、stream ID/settings/timing証跡、connect先・
  `:authority`・SNIの独立指定、connection reuseは未実装であり、完全なsemantic request editorとは表示しない。
