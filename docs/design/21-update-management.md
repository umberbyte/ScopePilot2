# 21 更新管理 概要設計

対応要件: 仕様書 5章、9章、A1 の版固定と切戻し

## 1. 目的

実行再現性を守る runtime bundle の固定と、新版を取得・審査する update channel を分離する。診断実行中に依存物を自動更新せず、検証済み bundle を原子的に切り替え、直前 bundle へ戻せるようにする。

## 2. Runtime bundle

一つの bundle manifest に次を記録する。

- ScopePilot app、Electron、Node、npm lockfile、SQLite binding。
- Playwright と Chromium。
- Java、ZAP core、add-on 一覧。
- Nuclei binary と template 集合。
- payload、独自 RulePackage、説明辞書、ガイドライン要約・項目対応表（[27](27-security-guidelines.md)）。
- 各成果物の版、供給元、SHA-256、署名検証結果、ライセンス、対応 OS/arch。

実行計画は bundle ID と manifest hash を固定する。実行前に全成果物を再検査し、一部でも欠落・差替え・非互換なら開始しない。ZAP/Nuclei 自身の auto-update は無効にする。

ZAP/Nuclei の挙動は我々の権限外で版により変わるため、各エンジンの capability manifest（[22](22-execution-control.md)§3 の保証等級・最大 overshoot・scope 遵守の実測）は bundle の版に属する。版を変更する bundle では capability fixture を再測定して manifest を書き直し、版をまたいで挙動を仮定しない。再測定で保証が下がった能力は公開を止める。

## 3. 更新手順

1. metadata を取得する。対象サイトの通信経路とは分離する。
2. 隔離 cache へ download し、供給元、署名、hash、サイズ、ライセンスを検証する。
3. 静的検査で禁止 protocol、任意 code、外部参照、scope 脱出の可能性を分類する。
4. offline fixture で契約試験と基準シナリオを実行する。
5. 審査結果付き manifest を作り、immutable bundle として登録する。
6. 次回の新規 run から active pointer を切り替える。実行中 run は旧 bundle を使い続ける。
7. health check 失敗時は直前 bundle へ戻す。bundle と結果は保持期間まで残す。

A1 はアプリ release に同梱した Stable bundle のみを使う。ネットワーク更新 UI、組織 mirror、Review channel は A2 以降とする。したがって A1 の版固定と切戻しは update 機能の完成を待たない。

## 4. npm とビルド依存

production dependency を役割ごとに記録し、Node/Electron 標準 API で足りるものは追加 library を採らない。lockfile を唯一の解決結果とし、install script、native addon、transitive dependency の変更を更新審査の対象にする。未使用依存と重複機能を CI で検出する。

Electron と Playwright/Chromium の更新は security release を含むため保留期限を設ける。更新できない場合は、理由、影響する機能、期限、代替制御を表示し、無期限に黙認しない。

## 5. Offline pack

別端末で作った pack は manifest、全 artifact、検証情報を含む。import 時に同じ検証と fixture を実行し、不一致や downgrade は既定で拒否する。明示的な rollback は履歴にある既検証 bundle だけを対象にする。

## 6. UI / CLI

更新画面は供給元ごとに「使用中」「取得済み」「検証済み」「保留」「失敗」を分け、単一の「最新」表示を使わない。CLI は `scopepilot update check|stage|verify|activate|rollback|export-pack|import-pack` と `scopepilot runtime verify` を提供する。

## 7. 受け入れ条件

1. 同じ plan と bundle から同じ engine 構成を復元できる。
2. 部分更新、途中失敗、署名/hash 不一致で active bundle が変化しない。
3. update 通信へ案件 URL、Cookie、文書、所見が含まれない。
4. 一世代 rollback 後に基準シナリオが完走する。
5. Windows/macOS の署名・公証用成果物も manifest と SBOM に対応付く。
6. エンジン版を変えた bundle で capability fixture を再測定し、manifest の保証等級・最大 overshoot・scope 遵守の実測値が版に対応して更新される。保証が下がった能力は自動的に公開対象から外れる。
