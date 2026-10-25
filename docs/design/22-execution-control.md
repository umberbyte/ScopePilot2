# 22 実行制御・上限・障害復旧 概要設計

対応要件: 仕様書 6.1、6.2、6.5、10.1

## 1. 目的

探索、受動診断、能動診断、Fuzzer、API、再送、Nuclei、WebSocket、OAST の実行を一つの計画・認可・予算モデルで制御する。ScopePilot 自身が発する通信は実際の送信経路で範囲と上限を強制する。ZAP や Nuclei のように内部挙動を制御できない外部エンジンは、scope を入力として与え、起動・停止を握り、出力から挙動を推測し、保証範囲を経路別に開示する。外部エンジンの内部実装は我々の権限外（版更新で変化しうる）であり、個々の送信を傍受・拒否して制御しようとしない。

## 2. 計画と状態遷移

`ExecutionPlan`は対象、`TargetRole`、操作者、操作区分、template、ジョブDAG、
request/page/time/byte/concurrency/rateの各上限、engine capability、runtime bundle、入力証拠、認可IDを
正規化しhash化する。

状態は `Draft → Validated → Authorized → Confirmed → Running → Stopping → Completed|Stopped|Failed` とする。
`Authorized`は計画hashを有効な案件認可へ結び付けた状態、`Confirmed`は操作者またはautomation grantが
同じplan hash、対象、操作、上限、routeを確認した状態であり、両者を代用しない。desktopはSimple / Advanced
とも送信開始前に`PlanConfirmation`を要求する。Simpleではこれが実行内容を変更しない最後の操作となる。
非対話CLI/CIは認可内の`AutomationGrant`（許可command、上限、期限、operator、plan hashまたは固定生成条件）を
必要とし、隠しoptionで確認を省略しない。認可失効、計画差分、runtime差分、AI提案採用による差分は
Runningへの遷移前にConfirmationを無効化する。子ジョブが新しい対象を発見した場合はorigin planを変更せず、
予算を引き継ぐ子計画へ追記し、grant外の操作なら再確認を要求する。

## 3. 通信の強制点

`EgressPolicy` は送信ごとに次を判定する。

- scheme、正規化 host、port、path、method、操作区分。
- DNS 解決後の IPv4/IPv6 と再解決結果。loopback、link-local、private range の許否。
- Host、接続先、SNI の組合せと、redirect ごとの再評価。
- 別 origin への Cookie、Authorization、client certificate の転送拒否。
- 案件共有予算からの lease 取得。lease のない送信は行わない。

通信経路別の保証は次の三段階で表す。これは送信元が ScopePilot か外部エンジンかで分かれる。

| 等級 | 保証の主体 | 内容 | 利用条件 |
|---|---|---|---|
| Enforced | ScopePilot | 各送信と redirect を送信前に判定し、範囲外を拒否する | Node 送信、管理 proxy、Playwright route など、ScopePilot 自身が発する通信 |
| Delegated | 外部エンジン | ScopePilot は scope/mode/rule/対象を入力として与え、起動・停止を握り、出力（history/message 数/report）から挙動を推測する。個々の送信は傍受・拒否しない。範囲遵守はエンジンの scope 機能へ委譲し、逸脱は事後検知して停止する | ZAP、管理 proxy を通せない Nuclei 経路など内部挙動を制御できないエンジン。固定した版ごとに挙動と最大 overshoot を実測し manifest へ記録した場合のみ |
| Unsupported | — | 入力 scope もライフサイクル停止も保証できない | 機能を公開しない |

ZAP、Nuclei、Playwright ごとに capability manifest へ各制約の等級と最大 overshoot を記録する。共有上限から engine へ小分けの lease を渡し、Delegated 経路では最大 overshoot 分を lease 内に予約する。予約内に収められない経路は Unsupported とする。**Delegated では「範囲外の送信前拒否」を保証しない**。入力 scope の付与、出力からの事後検知と停止、当該版での実測結果の開示でこれに代える。停止検知だけに依存して無制限の送信を許さない。外部エンジンを ScopePilot で完全制御しようとすると連携する利点（枯れた診断エンジンの活用）を失い、かつエンジン更新で壊れるため、制御ではなく委譲・推測・開示として扱う。

## 4. 経路別の設計

- Node の再送/API/Fuzzer: 管理 HTTP client を通し、redirect を自動追従せず一段ずつ判定する。
- Playwright: browser context の request interception で各 navigation、subresource、redirect を判定する。service worker を制御できない構成では無効化するか管理 proxy を必須にする。
- ZAP（Delegated）: context include/exclude、mode、rule、thread、delay、duration を入力として固定し、対象を ZAP history/context に登録してから実行する。個々の送信の傍受・拒否・書き換えはしない（ZAP 更新で壊れる結合を作らない）。予算 lease、API progress、ZAP message 増分を照合し、乖離時は停止する。範囲遵守は与えた context と当該版の実測挙動に依拠し、保証範囲を能力表へ開示する。
- Nuclei: target list、rate/concurrency、redirect、template 能力を固定し、可能なら管理 proxy を通す。直接 DNS/OAST/code 等を使う template は別 capability として既定無効にする。
- WebSocket/OAST: HTTP request 数と別に connection/message/callback budget を持ち、案件全体の time budget を共有する。

## 5. 過負荷と停止

RateGovernor は origin ごとの token bucket と案件全体の concurrency を管理する。429、Retry-After、5xx、latency、認証切れ、保存失敗、disk 空き容量低下を監視し、段階的に減速、一時停止、停止する。既定閾値と再開条件は計画に固定する。

停止時は新規 lease を止め、engine に協調停止を要求し、期限後に process tree を終了する。停止要求時刻、最後に観測した送信、停止後の overshoot、保存完了を run record へ残す。

## 6. 復旧

起動時に Running/Stopping の run を `Interrupted` として検出し、子プロセス、port、lock、temp blob を照合する。自動再開は行わない。利用者が再開を選んだ場合も、認可、plan hash、runtime、入力 hash、resume point を再検証する。冪等でない状態変更ジョブは新規計画として扱う。

## 7. A0/A1 受け入れ条件

1. Enforced 経路（Node/管理 proxy/Playwright）で、redirect、DNS rebinding、IPv6、別 origin credential 転送を送信前に拒否できる。Delegated 経路（ZAP/Nuclei）では、固定した版の fixture で、与えた scope の外への送信が観測されないことと、逸脱時に停止・記録することを実測・開示できる（送信前拒否は保証しない）。
2. 並行する複数 engine が案件共有上限を超えない。Delegated の overshoot が宣言値以内である。
3. 429/5xx、認証切れ、証拠保存失敗、利用者停止で、理由が一意に記録される。
4. 強制不能な engine/feature が plan validation で拒否される。
5. crash 後に完了扱いにならず、再開前の再検証が働く。
6. plan、runtime、認可、template、AI提案採用後のいずれかが変わると`PlanConfirmation`が失効する。
7. 非対話実行は有効な`AutomationGrant`なしに開始できず、grant外の子計画で停止する。
