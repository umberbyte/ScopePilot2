# F13 OAST

## 1. 対象

OAST token、callback correlation、self-host Interactsh、任意 BOAST provider、期限、証跡を扱う。上位は `design/12`, `24`。

## 2. UI/CLI

- Simple: 必要な check で provider 状態と外部通信の説明を表示。
- Advanced: A08/A13 で provider、protocol、保持期限、callback を管理。
- CLI: provider health、token issue、poll。資格情報は secret reference。

## 3. モジュール

`OastProviderRegistry`, `OastTokenIssuer`, `CorrelationStore`, `CallbackNormalizer`, `OastPoller`, `OastFindingLinker`。self-host Interactsh を baseline とし、provider capability を protocol 単位で宣言する。

## 4. 処理

token は case/job/check/attempt と一意に関連付け、外部へ出す値は内部 ID を露出しない。callback は provider event ID と raw hash で dedupe。poll は既定24時間、最大7日で終了し、期限後 callback を自動で所見へ結び付けない。

## 5. 安全・証跡

OAST domain、データ送信範囲、第三者 provider 利用を plan に表示する。callback 原本、provider version、受信時刻、clock skew、correlation 理由を保存する。token 自体は secret 相当として通常 report から除外する。

## 6. 失敗

provider unavailable は active request の成功と分離して記録する。protocol capability がなければ `Unsupported`。曖昧 correlation は finding を確定せず候補にする。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F13-UT-001 | `core/test/unit/oast/token-issuer.test.ts` | 同一 attempt で再発行 | 一意 token と履歴 |
| F13-UT-002 | `callback-normalizer.test.ts` | 同一 provider event | dedupe |
| F13-UT-003 | `correlation-store.test.ts` | 未知 token | uncorrelated と隔離 |
| F13-UT-004 | `oast-poller.test.ts` | 24h/7d 境界 | deadline を遵守 |
| F13-UT-005 | `provider-capability.test.ts` | DNS 非対応 | `Unsupported` |
| F13-UT-006 | `finding-linker.test.ts` | 曖昧 correlation | candidate のみ |
| F13-UT-007 | `oast-evidence.test.ts` | report projection | token/credential を除外 |

## 8. 非単体テスト

Interactsh protocol CT、隔離 DNS/HTTP callback IT、clock skew と遅延 callback FT を行う。外部 provider の実 credential は CI に固定しない。

### 現行 adapter

`InteractshCliProvider` は利用者が明示した self-host HTTPS origin と公式 client config
だけを使う。公式 `interactsh-client` を `-json -silent` で起動し、payload 発行後の
JSONL callback を `OastProviderPort` から Core の共通 dedupe/correlation 経路へ逐次渡す。
config 内の auth token は argv へ展開しない。常時 test は stub CLI で引数・payload・
callback・終了処理を検証し、実 server は環境変数 gated IT とする。

これは process 生存中の最小経路であり、永続 session、再起動後 poll、late callback、
provider version/health、BOAST、raw hash と request ID の完全な証跡は後続増分である。
