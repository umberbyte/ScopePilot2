# 12 OAST（コールバック検知） 概要設計

対応要件: 仕様書 F13・6.2（OAST）

## 1. 目的

帯外通信（DNS/HTTP/SMTP等のコールバック）を記録し、送信した要求と対応付ける。
Burp Collaborator 相当。A3 で提供する。

## 2. 技術選定

- 基準構成は**利用者または組織が管理する Interactsh 1.3.0以上**をZAP OAST API経由で利用する。
  DNS/HTTP/SMTPを同じfixtureで検証できるためである。ScopePilotは公開OASTサービスを運営しない。
- BOASTは既存の自己ホスト環境を利用する任意adapterとし、DNS/HTTP/HTTPS能力だけを公開する。
  SMTPが必要な計画へBOASTを選ばない。
- 公開サービスのURLは製品既定に持たず、自動接続しない。利用者が明示登録する場合は運営者、送信情報、
  retention、認証、利用条件を表示し、案件設定と監査イベントへ記録する。

## 3. コンポーネント構成

```text
OastAdapter（01のアダプター）:
  セッション: 管理サーバー or 利用者指定サーバーへの接続（認証・保持期間・待機時間を設定）
  ペイロード発行: 要求ごとに一意の識別子を生成（案件名・秘密値を埋め込まない）
  相関: 識別子↔送信要求（F04/F05/F11 の実行記録）の対応表
  受信取得: ポーリング（実行後の待機時間・遅延通知の再取得に対応）
```

- OAST用ペイロードは05のPayloadSet管理に「OAST系」として登録（版管理の対象）。
- 対象サーバーから外部への到達ができない環境では未実施とし、「受信がないことを脆弱性なしの
  証拠にしない」旨を表示・報告に明記（6.2）。

## 4. データモデル

- `OastInteraction`: 識別子・プロトコル・発信元情報・時刻・対応する送信要求Id・関連ジョブ。
- 診断観測への取込は「帯外受信の観測」区分で行い、実影響は人が確認（17）。

## 5. 安全制御と証跡

- 識別子はランダムで案件・秘密値を含めない。受信記録は案件証跡として保存（IP等の発信元情報を含む）。
- OASTサーバーへの問合せ通信は案件通信と別の接続先allowlist・rate/time上限で管理する。
  相関用のopaque識別子以外の案件名、URL、secret、request本文を送らない。

## 6. UI / CLI

- 診断実行画面に OAST セッション状態・受信一覧・対応要求へのリンク。
- CLI: `scopepilot oast poll --wait <分>`。

## 7. 確定事項

1. OAST serverはScopePilot配布物に含めず、組織管理の外部runtimeとして扱う。必要条件はTLS、認証token、
   固定base URL、時刻同期、保持期間、health check、export/delete手順である。これらを満たさない接続は
   `Unsupported`とするため、ScopePilot側の継続的な公開server費用は完成条件に含めない。
2. capabilityはDNS、HTTP、HTTPS、SMTPを別々に持ち、各protocolでpayload発行、対象fixtureからのcallback、
   poll、request相関、重複排除、再起動後pollを確認する。未検証protocolはUIに出さない。Interactshと
   BOASTの能力を合成して「OAST対応」と一括表示しない。
3. 送信runとOAST待機sessionを分離する。送信完了後はrunを`CompletedAwaitingCallbacks`とし、既定24時間、
   最大7日、既定60秒間隔でpollする。案件を閉じても期限内sessionは再開時にpollできる。遅延callbackは
   元runの結果を遡及変更せず、元requestを参照する新しい`OastInteraction`とobservationを受信時刻で追加する。
   期限後の受信は次回手動pollで`LateInteraction`として記録し、受信なしを陰性結果にしない。

根拠: [ZAP OAST API](https://www.zaproxy.org/docs/desktop/addons/oast-support/api/)、
[Interactsh support](https://www.zaproxy.org/docs/desktop/addons/oast-support/services/interactsh/)、
[BOAST support](https://www.zaproxy.org/docs/desktop/addons/oast-support/services/boast/)。
