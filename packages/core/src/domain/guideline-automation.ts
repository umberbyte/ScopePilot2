import type { GuidelineAutomationClass } from '@scopepilot2/contracts';

export const GUIDELINE_AUTOMATION_POLICY_VERSION = '2026-11-10.1';
export type GuidelineThemeNo = `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27 | 28 | 29 | 30}`;

export interface GuidelineThemeAutomationPolicy {
  readonly themeNo: GuidelineThemeNo;
  readonly automationClass: GuidelineAutomationClass;
  /** Only active-scan entries may enter the existing automatic send loop. */
  readonly connection: 'active-scan' | 'planned' | 'unsupported';
  readonly routeId: string;
  readonly requiredInputCodes: readonly string[];
  readonly inputResolutionPlan: string;
  /** Planned assertion, not a claim that an item mapping/assertion registry exists. */
  readonly assertionPlan: string;
  readonly deferredReason: string;
  readonly limitationCodes: readonly string[];
}

function policy(
  themeNo: GuidelineThemeNo,
  automationClass: GuidelineAutomationClass,
  requiredInputCodes: readonly string[],
  inputResolutionPlan: string,
  assertionPlan: string,
  deferredReason: string,
  limitationCodes: readonly string[],
  connection: GuidelineThemeAutomationPolicy['connection'] = 'planned',
): GuidelineThemeAutomationPolicy {
  return Object.freeze({ themeNo, automationClass, connection,
    routeId: connection === 'active-scan' ? `zap-unsupported:${themeNo}` : `theme:${themeNo}:${connection}`,
    requiredInputCodes: Object.freeze([...requiredInputCodes]), inputResolutionPlan, assertionPlan,
    deferredReason, limitationCodes: Object.freeze([...limitationCodes]) });
}

/** Product source of truth: design 41 §2.3. Target class does not grant permission to send. */
export const GUIDELINE_THEME_AUTOMATION_POLICIES: Readonly<Record<GuidelineThemeNo, GuidelineThemeAutomationPolicy>> = Object.freeze({
  '1': policy('1', 'conditional-automatic', ['verified-login-flow', 'unique-session-cookie', 'authenticated-marker'], '認証後URL・認証前後session・assert markerをlogin資産から一意解決', '同じURLの正常対照と未認証/改変sessionを比較', '認証Cookieと成功markerを一意に特定する必要があります', ['no-guessed-session']),
  '2': policy('2', 'conditional-automatic', ['sourced-default-credentials', 'dedicated-login-flow'], '出典付き文書hintを診断専用login flowへ結合。秘密値はmemory-only', '最大10組の文書由来資格候補で認証成否を比較', '出典付き既定資格候補と診断専用login flowが必要です', ['no-general-dictionary', 'max-10-pairs']),
  '3': policy('3', 'operator-workflow', ['test-account', 'password-change-flow', 'restore-flow'], '操作者が診断用アカウント・変更/復元flowをreview', '弱いpasswordの受理と応答露出を正常対照と比較', '診断用アカウントと変更・復元手順のreviewが必要です', ['storage-review-not-assessed']),
  '4': policy('4', 'external-fixture', ['reset-flow', 'authorized-mailbox', 'positive-control', 'restore-flow'], '許可済みmailbox capabilityと認証専用egressを解決', '対照付きreset token検証と復元', 'リセット手順、許可済みmailbox、正常対照、復元が必要です', ['no-token-bruteforce']),
  '5': policy('5', 'operator-workflow', ['test-account', 'agreed-attempt-limit', 'unlock-flow'], '操作者が試行数と解除手段を承認', '少数失敗後の正常login対照', '診断専用アカウント、許可試行数、解除手段が必要です', ['load-testing-excluded']),
  '6': policy('6', 'external-fixture', ['real-auth-adapter', 'authorized-auth-egress', 'subcheck-controls'], '実OTP/mailboxまたは管理下IdP/SP capabilityをsub-check別に解決', 'OTP再利用/期限/制限/宛先、SAML replayを独立判定', '許可済み実認証adapterとsub-checkごとの正常対照が必要です', ['fixture-is-not-production-evidence', 'unexecuted-subchecks-not-assessed']),
  '7': policy('7', 'conditional-automatic', ['test-user', 'confirmed-absent-user'], '存在/不存在を確認した比較名だけを案件資産から取得', '同一誤資格で少数の応答差を比較', '有効な診断用ユーザーと不存在確認済みの比較名が必要です', ['no-guessed-identities']),
  '8': policy('8', 'automatic', ['reviewed-item-workflow-mapping'], 'item mappingから既存workflow assertionを解決', '共有workflowの実施・skip・証拠をテーマへ投影', '項目単位のworkflow assertion mappingと実行記録の投影が未接続です', ['shared-workflow-not-item-specific']),
  '9': policy('9', 'conditional-automatic', ['observed-jwt', 'token-origin'], 'loginで観測したJWTをOrigin固定memory-onlyで取得', 'JWT受動検査。state/nonce/PKCEは認可flowがある場合だけ別判定', '観測済みJWTと対象Originが必要です', ['authorization-flow-not-assessed', 'no-persisted-token']),
  '10': policy('10', 'conditional-automatic', ['role-sessions', 'object-owner', 'observed-object-id', 'positive-control'], '複数role、所有主体、実在IDと正常対照を一意解決', '機能/オブジェクト認可のrole差分', '複数role session、所有主体、具体化済みID、正常対照が必要です', ['no-guessed-object-id']),
  '11': policy('11', 'operator-workflow', ['normal-body', 'reviewed-extra-field', 'effect-oracle', 'restore-flow'], 'schema/観測要求の正常bodyとreview済みfieldを使用', '追加fieldの実反映をoracleで確認し復元', '正常body、追加field、反映判定、復元のreviewが必要です', ['acceptance-is-not-effect']),
  '12': policy('12', 'automatic', ['reviewed-item-workflow-mapping'], 'item mappingから既存workflow assertionを解決', '共有workflowの実施・skip・証拠をテーマへ投影', '項目単位のworkflow assertion mappingと実行記録の投影が未接続です', ['shared-workflow-not-item-specific']),
  '13': policy('13', 'automatic', [], '採用済みHTTP対象から限定Origin probeを構築', 'CORS対照、資格情報適用、browser成立条件', '', ['browser-exploitability-not-proven'], 'active-scan'),
  '14': policy('14', 'external-fixture', ['closed-mail-sink', 'delivery-header-oracle'], '許可済み閉域mail sinkと配送header oracleを解決', '配送headerで注入の成立を確認', '閉域mail sinkと配送headerによる成立判定が必要です', ['http-2xx-is-not-delivery']),
  '15': policy('15', 'operator-workflow', ['normal-value', 'reviewed-mutation', 'success-or-time-oracle'], '審査済みtemplateと正常値だけを採用', '成功markerまたは時間oracleを対照と比較', '正常値、review済み変異値、成立oracleが必要です', ['no-generated-payload']),
  '16': policy('16', 'external-fixture', ['authorized-oast', 'correlation-oracle'], '自己ホストOASTまたは許可済み内部fixtureへ相関IDを割当', '相関した外部到達だけを成立根拠にする', '許可済みOAST/内部fixtureと到達相関が必要です', ['acceptance-is-not-ssrf']),
  '17': policy('17', 'unsupported', [], '送信stepを作らない', 'raw transport・二段parser・誤配送oracleが揃うまで成立判定しない', 'request smugglingは検査不能です。専用raw transport、二段parser、誤配送oracleが揃うまで送信しません', ['smuggling-send-prohibited', 'not-assessed'], 'unsupported'),
  '18': policy('18', 'automatic', ['observed-request-corpus'], '観測済みrequest corpusの署名だけを受動分類', '直列化signatureの候補分類。実害の成立は別route', '観測済みrequest corpusの受動分類routeが未接続です', ['passive-signature-only', 'gadget-exploitation-not-assessed']),
  '19': policy('19', 'automatic', ['reviewed-item-workflow-mapping'], 'item mappingから既存workflow assertionを解決', '共有workflowの実施・skip・証拠をテーマへ投影', '項目単位のworkflow assertion mappingと実行記録の投影が未接続です', ['shared-workflow-not-item-specific']),
  '20': policy('20', 'operator-workflow', ['reviewed-workflow', 'expected-result', 'restore-flow', 'idempotency', 'concurrency-limit'], '操作者が状態変更、復元、冪等性、並行上限をreview', '期待結果と実結果を比較。raceは専用同時実行oracleが必要', 'workflow、期待結果、復元、冪等性、並行上限が必要です', ['sequential-is-not-race-proof']),
  '21': policy('21', 'conditional-automatic', ['observed-safe-input', 'versioned-payload'], '観測入力点から状態変更/秘密値らしい入力を除外', '版固定payloadによる低回数probeと正常対照', '安全な観測入力点と版固定payloadの解決が必要です', ['exclude-state-changing-and-secret-input']),
  '22': policy('22', 'conditional-automatic', ['reviewed-tls-adapter', 'adapter-manifest'], '審査済みNuclei/OpenSSL相当adapterとmanifestを照合', 'TLS/証明書のengine観測結果をDelegatedとして表示', '審査済みTLS adapterとmanifestが必要です', ['delegated-engine-observation']),
  '23': policy('23', 'automatic', ['browser-resource-observations', 'redirect-chain'], 'HTTPS browser観測からsubresource schemeとredirect chainを取得', '平文/混在コンテンツを受動判定', 'browser観測とredirect chainの受動判定routeが未接続です', ['no-url-only-pass']),
  '24': policy('24', 'automatic', [], '採用済みHTTP対象へ既定probe', 'browser保護headerと対象文脈を観測', '', ['missing-header-is-not-exploit-proof'], 'active-scan'),
  '25': policy('25', 'automatic', [], '既定のOPTIONS/TRACE/TRACKのみ採用', 'method応答とTRACE echoを観測', '', ['put-delete-patch-require-review'], 'active-scan'),
  '26': policy('26', 'conditional-automatic', ['observed-graphql-endpoint', 'normal-query', 'query-limits'], '観測endpointと正常queryから上限付きqueryを構築', '正常対照、introspection、深さ/コスト上限の差分', '観測済みendpoint、正常query、深さ・コスト上限が必要です', ['no-control-no-assessment']),
  '27': policy('27', 'conditional-automatic', ['observed-websocket', 'real-websocket-transport', 'role-session'], '観測接続・実transport・role sessionを結合', 'Origin差分を実接続で比較', '観測済み接続、実WebSocket transport、role sessionが必要です', ['fixture-ledger-is-not-execution']),
  '28': policy('28', 'automatic', ['reviewed-item-workflow-mapping'], 'item mappingから既存workflow assertionを解決', '共有workflowの実施・skip・証拠をテーマへ投影', '項目単位のworkflow assertion mappingと実行記録の投影が未接続です', ['shared-workflow-not-item-specific']),
  '29': policy('29', 'conditional-automatic', ['public-response-assets', 'versioned-secret-patterns'], '公開応答と静的素材を版固定patternで受動検査', '形式確認済み候補だけmasked fingerprintとして記録', '公開応答・静的素材と版固定patternの解決が必要です', ['masked-fingerprint-only', 'no-external-validation']),
  '30': policy('30', 'automatic', [], '採用済みHTTP対象へ限定公開面probe', '公開情報の観測。辞書版、404負対照、上限を後続強化', '', ['bounded-public-surface-only'], 'active-scan'),
});

export function guidelineAutomationPolicy(themeNo: GuidelineThemeNo): GuidelineThemeAutomationPolicy {
  return GUIDELINE_THEME_AUTOMATION_POLICIES[themeNo];
}

/** Shared budget reservation for the connected probes; planned routes cannot reserve/send. */
export function automaticGuidelineRequestCount(themeNo: GuidelineThemeNo, targetCount: number): number {
  if (guidelineAutomationPolicy(themeNo).connection !== 'active-scan' || targetCount === 0) return 0;
  switch (themeNo) {
    case '13': return 6; // Same-origin/external/null Origin controls, GET + OPTIONS.
    case '24': return targetCount * 2;
    case '25': return 3; // OPTIONS, TRACE, TRACK; no state-changing method.
    case '30': return targetCount;
    default: return 0;
  }
}
