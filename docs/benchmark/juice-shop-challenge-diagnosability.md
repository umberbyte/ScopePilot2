# Juice Shop challenge 診断適用判定 (機械導出)

- 入力: `juice-shop-challenge-routes.json` (challenge 対象経路) × クロール観測ダンプ (診断トラック付き候補)
- 判定ツール: `docs/benchmark/judge-challenge-diagnosability.py`
- 観測: scopepilot2-juice-observations5.json

判定結果: {"診断適用可能": 66, "候補化されていない": 37, "機械判定対象外 (client-side)": 13}
トラック別適用challenge数: {"zap-active": 40, "api-schema": 39, "authorization-differential": 1}

| key | category | status | tracks | matched candidates |
|---|---|---|---|---|
| csrfChallenge | Broken Access Control | 候補化されていない | - | - |
| easterEggLevelOneChallenge | Broken Access Control | 候補化されていない | - | - |
| forgedReviewChallenge | Broken Access Control | 候補化されていない | - | - |
| timingAttackChallenge | Broken Anti Automation | 候補化されていない | - | - |
| twoFactorAuthUnsafeSecretStorageChallenge | Broken Authentication | 候補化されていない | - | - |
| continueCodeChallenge | Cryptographic Issues | 候補化されていない | - | - |
| easterEggLevelTwoChallenge | Cryptographic Issues | 候補化されていない | - | - |
| forgedCouponChallenge | Cryptographic Issues | 候補化されていない | - | - |
| premiumPaywallChallenge | Cryptographic Issues | 候補化されていない | - | - |
| manipulateClockChallenge | Improper Input Validation | 候補化されていない | - | - |
| negativeOrderChallenge | Improper Input Validation | 候補化されていない | - | - |
| nftMintChallenge | Improper Input Validation | 候補化されていない | - | - |
| nullByteChallenge | Improper Input Validation | 候補化されていない | - | - |
| christmasSpecialChallenge | Injection | 候補化されていない | - | - |
| noSqlCommandChallenge | Injection | 候補化されていない | - | - |
| noSqlOrdersChallenge | Injection | 候補化されていない | - | - |
| noSqlReviewsChallenge | Injection | 候補化されていない | - | - |
| rceChallenge | Insecure Deserialization | 候補化されていない | - | - |
| rceOccupyChallenge | Insecure Deserialization | 候補化されていない | - | - |
| closeNotificationsChallenge | Miscellaneous | 候補化されていない | - | - |
| web3WalletChallenge | Miscellaneous | 候補化されていない | - | - |
| misplacedSignatureFileChallenge | Observability Failures | 候補化されていない | - | - |
| svgInjectionChallenge | Security Misconfiguration | 候補化されていない | - | - |
| privacyPolicyProofChallenge | Security through Obscurity | 候補化されていない | - | - |
| dataExportChallenge | Sensitive Data Exposure | 候補化されていない | - | - |
| directoryListingChallenge | Sensitive Data Exposure | 候補化されていない | - | - |
| forgottenBackupChallenge | Sensitive Data Exposure | 候補化されていない | - | - |
| forgottenDevBackupChallenge | Sensitive Data Exposure | 候補化されていない | - | - |
| nftUnlockChallenge | Sensitive Data Exposure | 候補化されていない | - | - |
| redirectChallenge | Unvalidated Redirects | 候補化されていない | - | - |
| redirectCryptoCurrencyChallenge | Unvalidated Redirects | 候補化されていない | - | - |
| lfrChallenge | Vulnerable Components | 候補化されていない | - | - |
| localXssChallenge | XSS | 候補化されていない | - | - |
| reflectedXssChallenge | XSS | 候補化されていない | - | - |
| usernameXssChallenge | XSS | 候補化されていない | - | - |
| videoXssChallenge | XSS | 候補化されていない | - | - |
| xssBonusChallenge | XSS | 候補化されていない | - | - |
| weirdCryptoChallenge | Cryptographic Issues | 機械判定対象外 (client-side) | - | - |
| csafChallenge | Miscellaneous | 機械判定対象外 (client-side) | - | - |
| hiddenImageChallenge | Security through Obscurity | 機械判定対象外 (client-side) | - | - |
| dlpPastebinDataLeakChallenge | Sensitive Data Exposure | 機械判定対象外 (client-side) | - | - |
| iacLeakedKeyChallenge | Sensitive Data Exposure | 機械判定対象外 (client-side) | - | - |
| leakedApiKeyChallenge | Sensitive Data Exposure | 機械判定対象外 (client-side) | - | - |
| jwtForgedChallenge | Vulnerable Components | 機械判定対象外 (client-side) | - | - |
| jwtUnsignedChallenge | Vulnerable Components | 機械判定対象外 (client-side) | - | - |
| knownVulnerableComponentChallenge | Vulnerable Components | 機械判定対象外 (client-side) | - | - |
| supplyChainAttackChallenge | Vulnerable Components | 機械判定対象外 (client-side) | - | - |
| typosquattingAngularChallenge | Vulnerable Components | 機械判定対象外 (client-side) | - | - |
| typosquattingNpmChallenge | Vulnerable Components | 機械判定対象外 (client-side) | - | - |
| vulnerableDockerImageChallenge | Vulnerable Components | 機械判定対象外 (client-side) | - | - |
| adminSectionChallenge | Broken Access Control | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| aiDebuggingChallenge | Broken Access Control | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/chat |
| basketAccessChallenge | Broken Access Control | 診断適用可能 | authorization-differential | http://127.0.0.1:53187/rest/basket/6 |
| basketManipulateChallenge | Broken Access Control | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/BasketItems |
| changeProductChallenge | Broken Access Control | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| feedbackChallenge | Broken Access Control | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| forgedFeedbackChallenge | Broken Access Control | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| ssrfChallenge | Broken Access Control | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| web3SandboxChallenge | Broken Access Control | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| captchaBypassChallenge | Broken Anti Automation | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| extraLanguageChallenge | Broken Anti Automation | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| resetPasswordMortyChallenge | Broken Anti Automation | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| changePasswordBenderChallenge | Broken Authentication | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/change-password?current= |
| ghostLoginChallenge | Broken Authentication | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| oauthUserPasswordChallenge | Broken Authentication | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| resetPasswordBenderChallenge | Broken Authentication | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| resetPasswordBjoernChallenge | Broken Authentication | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| resetPasswordBjoernOwaspChallenge | Broken Authentication | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| resetPasswordJimChallenge | Broken Authentication | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| weakPasswordChallenge | Broken Authentication | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| emptyUserRegistration | Improper Input Validation | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| freeDeluxeChallenge | Improper Input Validation | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/deluxe-membership |
| missingEncodingChallenge | Improper Input Validation | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| passwordRepeatChallenge | Improper Input Validation | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| registerAdminChallenge | Improper Input Validation | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| uploadSizeChallenge | Improper Input Validation | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| uploadTypeChallenge | Improper Input Validation | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| zeroStarsChallenge | Improper Input Validation | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| chatbotGreedyInjectionChallenge | Injection | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/chat |
| chatbotPromptInjectionChallenge | Injection | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/chat |
| dbSchemaChallenge | Injection | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/products/search?q= |
| ephemeralAccountantChallenge | Injection | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginAdminChallenge | Injection | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginBenderChallenge | Injection | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginJimChallenge | Injection | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| sstiChallenge | Injection | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| systemPromptExtractionChallenge | Injection | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| unionSqlInjectionChallenge | Injection | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/products/search?q= |
| yamlBombChallenge | Insecure Deserialization | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| privacyPolicyChallenge | Miscellaneous | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| scoreBoardChallenge | Miscellaneous | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| securityPolicyChallenge | Miscellaneous | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| accessLogDisclosureChallenge | Observability Failures | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| dlpPasswordSprayingChallenge | Observability Failures | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| exposedMetricsChallenge | Observability Failures | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| deprecatedInterfaceChallenge | Security Misconfiguration | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| errorHandlingChallenge | Security Misconfiguration | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| loginSupportChallenge | Security Misconfiguration | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| misplacedIacFiles | Security Misconfiguration | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| tokenSaleChallenge | Security through Obscurity | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| emailLeakChallenge | Sensitive Data Exposure | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/whoami?fields=email<br>http://127.0.0.1:53187/rest/user/whoami |
| exposedCredentialsChallenge | Sensitive Data Exposure | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| geoStalkingMetaChallenge | Sensitive Data Exposure | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| geoStalkingVisualChallenge | Sensitive Data Exposure | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| loginAmyChallenge | Sensitive Data Exposure | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginRapperChallenge | Sensitive Data Exposure | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| passwordHashLeakChallenge | Sensitive Data Exposure | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/whoami?fields=email<br>http://127.0.0.1:53187/rest/user/whoami |
| resetPasswordUvoginChallenge | Sensitive Data Exposure | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| retrieveBlueprintChallenge | Sensitive Data Exposure | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| fileWriteChallenge | Vulnerable Components | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| httpHeaderXssChallenge | XSS | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/saveLoginIp |
| persistedXssFeedbackChallenge | XSS | 診断適用可能 | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| persistedXssUserChallenge | XSS | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/api/Users<br>http://127.0.0.1:53187/rest/user |
| restfulXssChallenge | XSS | 診断適用可能 | api-schema<br>zap-active | http://127.0.0.1:53187/api/Products<br>http://127.0.0.1:53187/rest/products |
| xxeDosChallenge | XXE | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| xxeFileDisclosureChallenge | XXE | 診断適用可能 | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |