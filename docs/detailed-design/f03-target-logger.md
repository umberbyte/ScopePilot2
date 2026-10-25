# F03 HTTP 履歴・Target・Logger

## 1. 対象

観測通信の取込、重複除外、cursor、Site map、検索・filter・大量表示を扱う。上位は `design/03`, `09`, `20`。

## 2. UI/CLI

- Simple: S04 で endpoint 集約と推奨候補のみ。
- Advanced: A04 で HTTP history、Site map、原本 viewer、filter/export。
- CLI: cursor 付き `traffic list/show/export`。

## 3. モジュール

`MessageImporter`, `ImportCursor`, `MessageFingerprint`, `SiteMapProjector`, `TrafficQuery`, `TrafficPresenter`。ZAP message は adapter DTO から標準 `ObservedExchange` へ変換する。

## 4. データと処理

fingerprint は engine instance、engine message ID、方向、raw hash を組み合わせる。同一原本の再取込は既存 ID を返す。cursor は engine instance ごとに単調増加し、巻戻りや欠番を anomaly として記録する。

Site map は canonical origin/path/method/content-type/status の集約で、query は既定 100、最大 500 件。body 検索 index は既定先頭 1 MiB とし、原本の存在と検索対象範囲を区別する。

## 5. 安全・証跡

原本 file hash、取込元、engine version、観測時刻、import attempt を保存する。document hint は観測通信に昇格させず別 origin type とする。

## 6. 失敗

壊れた message は batch 全体を失敗させず quarantine。cursor 巻戻りは自動削除せず再走査と dedupe を行う。100,000 件超は集約 view を返す。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F03-UT-001 | `core/test/unit/target-logger/fingerprint.test.ts` | 同一 message 再取込 | 同一 fingerprint |
| F03-UT-002 | `import-cursor.test.ts` | cursor 巻戻り | anomaly と再走査指示 |
| F03-UT-003 | `message-importer.test.ts` | 1件 malformed | quarantine し他を継続 |
| F03-UT-004 | `site-map-projector.test.ts` | query だけ異なる URL | policy に従い endpoint 集約 |
| F03-UT-005 | `traffic-query.test.ts` | limit 501 | `ValidationFailed` |
| F03-UT-006 | 同上 | 100,001 件 | summary mode を選択 |
| F03-UT-007 | `origin-type.test.ts` | document hint | observed=false を保持 |

## 8. 非単体テスト

SQLite FTS/transaction を IT、ZAP history pagination と `URL Does not Exist` 回避を版別 FT、大量仮想 scroll を UI app test で検証する。
