# 単体テスト戦略

## 1. 原則

単体テストは詳細設計の振る舞いを、外部環境なしで高速かつ決定的に検証する。TypeScript を compile した上で Node 標準の `node:test` と `node:assert/strict` を使い、不要な test framework 依存を増やさない。

単体テストは安全制御のロジックを検証するが、ZAP・Nuclei・Playwright・SQLite・OS key store・network の実際の挙動を保証しない。これらは契約、統合、fixture テストを別に持つ。

## 2. テスト種別

| 種別 | 接尾辞 | 対象 | 外部 I/O |
|---|---|---|---|
| Unit | `UT` | domain、policy、parser、presenter、state machine | 禁止 |
| Contract | `CT` | OpenAPI/JSON Schema、event、adapter protocol | schema/fixture のみ |
| Integration | `IT` | SQLite、process、ZAP/Nuclei API、Playwright | 許可された局所 I/O |
| Fixture/flow | `FT` | 探索→診断→所見の自動完走 | 隔離した検証環境のみ |

## 3. 配置と命名

```text
packages/<name>/test/unit/<feature>/<subject>.test.ts
packages/contracts/test/contract/<contract>.test.ts
packages/<name>/test/integration/<adapter>.test.ts
tools/simulation/test/fixture/<flow>.test.ts
```

テスト名は `test("[Fnn-UT-nnn] 振る舞い", ...)` の形式にする。1 ID は1つの観測可能な振る舞いを表し、parameterized case は同じテスト内で列挙する。

## 4. 注入点と fake

- 時刻は `Clock`、ID は `IdGenerator`、乱数は `RandomSource` を注入する。
- repository、engine、evidence、secret store は最小の手書き fake を使う。
- fake は呼出し記録と明示した結果だけを提供し、実装ロジックを複製しない。
- timer の実時間待機を避け、virtual clock で deadline と retry を進める。
- fixture は個人情報・実秘密値を含めず、原本 hash を固定する。
- AI は provider の返答を録画した fixture ではなく、構造化提案 port の成功・失敗・malformed を与える。

## 5. 単体テストの境界

単体テストでは、ネットワーク socket、子 process、Electron、実 DB、OS key store を起動しない。JSON Schema validator の wrapper は実 production validator を使う契約テストを追加する。HTTP parser や URL canonicalization は標準 API を使った純粋処理として単体テストできる。

送信前拒否は unit で全分岐を検証し、外部エンジンの scope 遵守は実測 fixture で観察する。後者に失敗した版は `CapabilityUnavailable` とし公開しない。

## 6. 必須ケース

各 feature は最低限、次を対応表へ含める。

1. 正常な最小入力。
2. schema/値境界の拒否。
3. permission/scope/confirmation の拒否。
4. timeout/cancel/retry または該当しない理由。
5. evidence/provenance の生成。
6. 外部 port 失敗時に誤って成功扱いしないこと。

## 7. 完了ゲート

- 詳細設計に列挙した全 UT ID が test source に一意に存在する。
- 新規 domain branch に対応する ID がある。
- test は順序、locale、timezone、実時計に依存しない。
- `npm test` は network 不要で unit/contract を実行できる。
- integration/fixture は明示した script と環境条件で分離される。
- skipped test は理由、issue、期限を持ち、通常成功に数えない。
- coverage 数値だけを受け入れ条件にせず、設計 ID の充足と重要変異の検出を優先する。

## 8. CI 段階

`lint/typecheck → unit → contract → package → integration(smoke) → simulation fixture` の順とする。PR 必須は network 不要の unit/contract まで、外部バイナリを使う段階は固定版 runner で実行し、結果に tool version と capability snapshot を保存する。
