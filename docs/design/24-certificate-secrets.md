# 24 証明書・秘密情報 概要設計

対応要件: 仕様書 6.2、6.4

## 1. 目的

HTTPS 記録用 CA、対象サーバー証明書の検証、認証情報、API key、cookie、client certificate を案件と実行に結び付け、平文の複製と過剰な信頼を避ける。

## 2. HTTPS 記録用 CA

ZAP のルート CA は ScopePilot 管理外の既存 ZAP home と共用しない。用途別の専用 profile に生成し、秘密鍵を [20](20-storage-evidence.md) の保護領域へ置く。UI は fingerprint、生成元、作成日、有効期限、利用中 profile、信頼登録状態を表示する。

OS trust store への恒久登録を既定にしない。可能な場合は Playwright の専用 profile だけに信頼を限定する。OS 登録が必要な手動 proxy では、登録対象、影響、削除手順を表示し、明示操作と audit event を要求する。案件終了時に残存を検査し、削除できなかった場合は警告する。

CA private key を export しない。案件共有に必要なのは証拠と設定であり、同じ CA を複数端末へ配らない。各端末で再生成し、fingerprint の違いを移行記録へ残す。

## 3. 対象サーバー証明書

中継時も対象サーバーの chain、hostname、有効期限を検証する。自己署名などの例外は origin と fingerprint を固定し、期限付きで記録する。すべての証明書エラーを無視する全体 option は設けない。観測した certificate chain と検証結果は通信証拠へ紐付ける。

certificate pinning などで中継できない場合は、無効化を自動で試みず、未観測範囲として表示する。

## 4. SecretStore

`SecretRef` は provider、opaque ID、用途、案件、role、作成日、最終利用日を持ち、値を持たない。Windows は DPAPI/Credential Manager、macOS は Keychain を adapter で利用する。core と renderer は値ではなく参照を渡し、外部 engine へ必要な最短時間だけ注入する。

環境変数、command line、URL、通常ログへ秘密値を渡さない。stdin、権限制限した一時 file、engine 固有 secret API の順に選び、一時 file は終了時と crash recovery 時に消去する。完全消去を保証できない媒体ではその限界を表示する。

## 5. 表示、保存、監査

原本通信に含まれた secret は暗号化原本として保持できるが、索引、FTS、event、report には入れない。UI の reveal、copy、export、secret 更新、CA trust 変更は audit event に残す。文書から抽出した認証情報は値を複製せず、文書内位置と用途候補だけを hint として保存する。

## 6. 受け入れ条件

1. 案件 DB、通常 log、crash report、CLI 引数に fixture secret が出現しない。
2. 別 origin redirect へ Authorization/Cookie/client certificate を転送しない。
3. CA の作成、信頼登録、利用、削除を Windows/macOS で追跡できる。
4. portable export は元端末の OS secret store がなくても、明示した passphrase でだけ開ける。
5. server certificate 例外が origin/fingerprint/期限のいずれかを欠く場合は実行を拒否する。
