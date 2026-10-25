# F06 Decoder・Comparer

## 1. 対象

安全な codec 変換と、text/binary/HTTP message の比較を提供する。上位は `design/06`, `20`。

## 2. UI/CLI

- Simple: 結果レビュー内の差分表示だけを利用。
- Advanced: A10 で変換 chain、入力/出力、比較方式を編集。
- CLI: `decode`, `encode`, `compare`。stdin/stdout は binary-safe option を持つ。

## 3. モジュール

`CodecRegistry`, `TransformPipeline`, `TextComparer`, `BinaryComparer`, `HttpMessageComparer`, `DiffPresenter`。標準 codec は URL、Base64、hex、HTML entity、JSON string、gzip/deflate（展開上限付き）。任意 code execution は提供しない。

## 4. 処理

入力は byte sequence と charset hint を分離する。各 transform は input/output media type、最大入力、最大出力、可逆性を宣言する。Comparer は canonicalization option を明示し、元 byte 列を変更しない。

## 5. 安全・証跡

圧縮 bomb を出力 byte 数と比率で停止する。秘密値らしい入力は自動で evidence に保存せず、利用者が案件証跡へ添付した場合だけ secret policy を適用する。比較結果は元 artifact hash と option を持つ。

## 6. 失敗

不正 encoding は offset 付き `ValidationFailed`。lossy charset conversion は警告なしに実行しない。巨大 diff は full matrix を作らず要約へ切り替える。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F06-UT-001 | `core/test/unit/decoder-comparer/codec-registry.test.ts` | 未登録 codec | validation error |
| F06-UT-002 | `transform-pipeline.test.ts` | Base64→gzip | 順序通り bytes を返す |
| F06-UT-003 | 同上 | 展開上限超過 | 途中停止し部分値を成功扱いしない |
| F06-UT-004 | `text-comparer.test.ts` | LF/CRLF option | option 有無で差分が変わる |
| F06-UT-005 | `http-message-comparer.test.ts` | header 順のみ相違 | raw と semantic の結果を分離 |
| F06-UT-006 | `binary-comparer.test.ts` | 大容量 | bounded summary を返す |
| F06-UT-007 | `diff-provenance.test.ts` | 比較保存 | 両 artifact hash と option を保持 |

## 8. 非単体テスト

browser/Node codec の互換 fixture、巨大 file の性能試験、UI diff virtualization を別テストで扱う。
