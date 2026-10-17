# 20 保存モデル・証拠 概要設計

対応要件: 仕様書 6.3、6.5、8章

## 1. 目的

SQLite を索引・状態・関係に、ファイルを大きい本文と証拠に使う。10万件の通信を全件メモリへ載せず、要求から報告まで追跡でき、原本と共有用データを混同しない保存モデルを定める。

## 2. 案件レイアウト

```text
case/
  scopepilot.db
  evidence/
    blobs/<sha256>          暗号化した原本または派生物
  runs/<run-id>/
    manifest.json           計画、認可、runtime bundle、停止理由への参照
    engine/                 上限付き stdout/stderr と engine 固有成果物
  exports/                  利用者が明示生成した共有用成果物
  locks/
```

DB と manifest は相対参照を使う。書き込みは一つの storage service に集約し、SQLite transaction と temp file→fsync→atomic rename の順で DB と blob の不整合を避ける。案件は writer 一つ、reader 複数とし、異常終了後は WAL と blob index を検査する。

## 3. 主要モデル

| モデル | 内容 |
|---|---|
| cases / roles / authorizations | 案件、ロール、認可と失効履歴 |
| plans / jobs / runs | 正規化計画、状態遷移、runtime、停止理由 |
| endpoints / exchanges | URL pattern、通信索引、role、source、protocol |
| observations / findings / coverage | 機械観測、人の確認、実施・未実施範囲 |
| evidence_objects | 種別、機密区分、SHA-256、長さ、暗号方式、blob 参照 |
| evidence_links | 原本、表示用派生物、共有用派生物の関係 |
| payload_sets / rule_packages / runtimes | 供給元、版、hash、審査状態 |
| document_sources / document_hints | 文書原本と未確認ヒント |
| audit_events | 秘密表示、export、認可変更、実行、削除 |

## 4. 原本、表示、共有

- **原本**: 実際に送受信または取得したバイト列。暗号化して保存し、後から内容を書き換えない。
- **表示用派生物**: UI でマスク・整形した内容。派生元 hash、マスク規則版、生成時刻を持つ。
- **共有用派生物**: export ごとに生成し、対象、除外、マスク結果の manifest を付ける。

パスワードなど、取得自体が不要な秘密は原本へ複写しない。取得済み通信をマスクして原本と称することもしない。証拠参照は content hash と DB ID の両方を持ち、hash は完全性の根拠、暗号化は秘匿の手段として分ける。

## 5. 暗号化と鍵

案件ごとに data encryption key を生成し、Windows DPAPI または macOS Keychain で保護した key envelope を保存する。portable export は利用者が設定した passphrase から導出した鍵で別に包み直す。鍵、passphrase、secret store の値を DB、ログ、manifest に平文保存しない。詳細は [24](24-certificate-secrets.md) に従う。

## 6. 性能と上限

一覧 API は cursor pagination を使い、本文を返さない。本文は range/stream で遅延読込し、検索用に許可された派生テキストだけを FTS5 へ入れる。巨大応答は設定上限で打ち切り、保存済み byte 数、推定全長、打切り理由を記録する。

10万件 fixture で、初回表示、ページ移動、filter、本文表示、export、異常終了後の復旧を測る。基準値は A0 の基準端末と共に [26](26-requirements-traceability.md) へ固定する。

## 7. 移行と削除

本リポジトリに削除済みの C#/WPF 形式を起点とする段階移行は設けない。旧 ScopePilot 案件の import は独立した one-way importer とし、元データを変更しない。schema migration は開始前バックアップ、事前容量確認、適用履歴、失敗時 rollback を備える。

削除は DB row と blob の参照数を分け、retention job が未参照 blob を消す。削除、export、原本表示は audit event に残す。

## 8. CLI と受け入れ条件

`scopepilot db check|migrate|export|vacuum` を提供する。A1 では、クラッシュ後に完了扱いの run が生まれないこと、hash 不一致を検出すること、マスク済み export から原本秘密値が除外されること、OS 間 portable export を復号できることを検証する。
