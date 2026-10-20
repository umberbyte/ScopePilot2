# F07 Sequencer

## 1. 対象

token sample の収集、品質統計、可視化、再現可能な判定を提供する。上位は `design/06`, `22`。

## 2. UI/CLI

- Simple: 所見に含まれる要約だけ。
- Advanced: A10 で token 抽出規則、sample 数、収集進捗、分析を表示。
- CLI: `sequencer plan/run/analyze`。送信を伴う run は確認必須。

## 3. モジュール

`TokenExtractor`, `SamplePlan`, `SampleCollector`, `EntropyAnalyzer`, `BitDistributionAnalyzer`, `SequencerAssessment`。最小30、既定100、最大10,000 sample。

## 4. 処理

各 response から bounded extractor で token bytes を抽出し、欠落/重複も sample outcome として数える。分析は観測 sample に対する統計であり、暗号学的安全性を断定しない。algorithm/version と sample hash list を記録する。

## 5. 安全・証跡

収集 request は F05 と同じ rate/scope/stop gate を通す。token 原文は secret 扱いで暗号化し、通常の report には統計だけを載せる。

## 6. 失敗

30 未満は `InsufficientSample`、10,000 超は拒否。抽出失敗率が閾値を超える場合は分析せず `NeedsInput`。結果を脆弱性確定へ自動変換しない。

## 7. 単体テスト対応

| ID | test file | シナリオ | 期待結果 |
|---|---|---|---|
| F07-UT-001 | `core/test/unit/sequencer/sample-plan.test.ts` | 29/10001 sample | 境界外を拒否 |
| F07-UT-002 | `token-extractor.test.ts` | token 欠落 | missing outcome |
| F07-UT-003 | `sample-collector.test.ts` | duplicate token | sample と重複数を保持 |
| F07-UT-004 | `entropy-analyzer.test.ts` | 固定 bytes | 決定的な低 entropy 結果 |
| F07-UT-005 | `assessment.test.ts` | sample 不足 | 断定せず insufficient |
| F07-UT-006 | `token-evidence.test.ts` | report projection | token 原文を除外 |
| F07-UT-007 | `application/sequencer-session.test.ts` | cancel | 新規 request と完了sessionを作らない |
| F07-UT-008 | `sample-plan.test.ts` | 応答 Set-Cookie | 指定cookie名の値だけを抽出 |
| F07-UT-009 | `sample-plan.test.ts` | HTML hidden input | 指定field名のdecode済み値だけを抽出 |
| F07-UT-010 | `sample-plan.test.ts` | 応答 Authorization | Bearer b64tokenだけを抽出 |
| F07-UT-011 | `sample-plan.test.ts` | UTF-8 byte頻度 | 0x00–0xFFを固定16区間へ集約し、正しいbyte数でentropyを算出 |
| F07-UT-012 | `sample-plan.test.ts` | custom delimiter | regexを実行せず、1 MiB走査・4 KiB token上限内で最初のdelimiter対から抽出 |
| F07-UT-013 | `sample-plan.test.ts` | token長分布 | UTF-8 byte長とUnicode code point数を固定16区間へ別々に集約 |
| F07-UT-014 | `sample-plan.test.ts` | alphabet構成 | 種類数と固定文字classへ集約し、文字自体や並びを返さない |
| F07-UT-015 | `sample-plan.test.ts` | 文字位置別頻度 | 先頭64 Unicode code pointを位置ごとの固定文字classへ集約し、超過sample数だけを返す |
| F07-UT-016 | `sample-plan.test.ts` | token当たりentropy | 観測token値の経験分布から算出し、固定値は0・等確率4種類は2 bits/tokenとなる |
| F07-UT-017 | `sample-plan.test.ts` | 最長同一文字連長 | Unicode code point単位の最長連続数を固定16区間へ集約し、文字自体や個別連長を返さない |
| F07-UT-018 | `sample-plan.test.ts` | 隣接tokenのHamming距離 | 同一UTF-8 byte長の隣接pairをbit単位で比較して固定16区間へ集約し、異長pairは件数だけを返す |

## 8. 非単体テスト

既知分布 fixture による algorithm CT に加え、`NodeSequencerTransport` と所有 HTTP server
を結合し、実 request の既定 2 RPS、30 sample 収集、本文・Set-Cookie・hidden input・Bearer token 抽出、通信 log、token
原文の非保存、cancel後の追加送信防止、API client切断からのcancel伝播を常時 IT で確認する。固定16区間のbyte頻度、UTF-8 byte長/Unicode文字長/最長同一文字連長/隣接tokenのbit Hamming距離分布、alphabet文字class構成、先頭64文字の位置別class頻度、観測token値の経験entropy、custom delimiter抽出はCore/API ITとA10 app testで確認する。

## 9. 現行の認証session適用

- API/UIの任意 `role` は `runLogin` 成功済みsessionだけを参照する。Coreが対象URLのdomain/pathに
  適用可能なcookieを選び、`NodeSequencerTransport`へ渡す。未login roleは送信前に拒否する。
- transportは各逐次GETへCookie headerを付けるが、値を応答・session台帳・監査・通信logへ返さない。
  結果と台帳には取得条件としてcookie名だけを残す。roleなしの非認証収集も維持する。
- 現行extractorは本文 `token=...`、名前を明示した応答 `Set-Cookie`、HTMLの`hidden` input、応答 `Authorization` のBearer token、または本文のcustom delimiter対を選択できる。cookie名はRFC token文字、
  field名は安全な文字と各128文字以下に限定する。hidden inputは最大1,024個・1 tag 8 KiBの属性走査とし、属性順・引用符・HTML entityを扱う。Bearerはschemeを大小文字非依存で照合し、RFC 6750のb64token構文に一致する単一値だけを抽出する。
- custom delimiterは開始・終了を各UTF-8 128 bytes以下、control文字なしに制限し、本文1 MiB・抽出token 4 KiBを上限とする。ReDoSを持ち込む任意regexは受け付けず、超過時は部分統計を成功扱いしない。
- token値は収集中だけ扱って結果・session台帳・監査・通信logへ残さない。結果には抽出元と、該当するcookie名・field名・delimiter対だけを残す。
- A10の停止操作は実行中のfetchをabortする。API serverはclient切断をCore・transportの`AbortSignal`へ伝播し、進行中のHTTP要求を破棄して次のrequestを送らない。中断した採取は結果・完了session・完了監査eventを作らない。
- 解析済み結果は0x00–0xFFを上位nibbleごとの固定16区間へ集約し、A10で相対頻度barとして表示する。bucket件数だけを返し、token原文や個々のbyte列は返さない。
- token長は0、1、2、3–4、以降を概ね倍幅、8,193以上までの固定16区間へ集約する。UTF-8 byte長とUnicode code point数を別々の相対頻度barで表示し、個々のsample長やtoken原文は返さない。
- alphabetは観測したUnicode code pointの種類数だけを返し、出現文字は数字・ASCII大小文字・Base64URL記号・Base64記号・padding・その他ASCII・非ASCIIの固定8 classへ集約する。文字自体や位置順を返さず、固定tokenの復元を避ける。
- 文字位置別頻度は先頭64 Unicode code pointだけを対象に、各位置を同じ固定8 classへ集約する。64文字を超えたtokenは超過sample数だけを返し、文字自体や個別sample長は返さない。A10は位置を行、classを列とするscroll可能な表で表示する。
- token当たりentropyは観測token値の出現比率からShannon entropyを算出する。token原文や値別件数は返さず、sample数に制約された経験値として表示し、予測可能性や暗号学的安全性の断定には使わない。
- 連長はtoken内で最も長い同一Unicode code point連続数を求め、token長と同じ固定16区間へsample数だけを集約する。空tokenは0区間とし、文字自体・位置・個別tokenの連長は返さない。A10は相対頻度barで表示する。
- Hamming距離は収集順で隣接するtokenのUTF-8 byte列が同じ長さの場合だけbit単位で算出し、token長と同じ固定16区間へpair数を集約する。長さが異なるpairはpaddingや切捨てをせず件数だけを返す。token原文・pair別距離・比較byte列は返さず、A10は相対頻度barと異長pair数を表示する。
- custom delimiterは本文抽出規則だけを差し替える。method/header/bodyを任意化する完全な採取専用再送計画とは区別する。
