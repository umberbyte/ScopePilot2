# Juice Shop challenge 診断トラック候補の付与状況 (参考値・機械導出)

- 入力: `juice-shop-challenge-routes.json` (challenge 対象経路) × クロール観測ダンプ (診断トラック付き候補)
- 判定ツール: `docs/benchmark/judge-challenge-diagnosability.py`
- 観測: scopepilot2-juice-observations5.json

> この表は粗い経路対応と候補トラックの交差です。診断の実行可能性や challenge の検出を証明しません。

判定結果: {"診断トラック候補あり": 66, "トラック候補なし": 37, "機械判定対象外 (client-side)": 13}
トラック別候補challenge数: {"zap-active": 40, "api-schema": 39, "authorization-differential": 1}

| key | category | status | tracks | matched candidates |
|---|---|---|---|---|
| csrfChallenge | Broken Access Control | トラック候補なし | - | - |
| easterEggLevelOneChallenge | Broken Access Control | トラック候補なし | - | - |
| forgedReviewChallenge | Broken Access Control | トラック候補なし | - | - |
| timingAttackChallenge | Broken Anti Automation | トラック候補なし | - | - |
| twoFactorAuthUnsafeSecretStorageChallenge | Broken Authentication | トラック候補なし | - | - |
| continueCodeChallenge | Cryptographic Issues | トラック候補なし | - | - |
| easterEggLevelTwoChallenge | Cryptographic Issues | トラック候補なし | - | - |
| forgedCouponChallenge | Cryptographic Issues | トラック候補なし | - | - |
| premiumPaywallChallenge | Cryptographic Issues | トラック候補なし | - | - |
| manipulateClockChallenge | Improper Input Validation | トラック候補なし | - | - |
| negativeOrderChallenge | Improper Input Validation | トラック候補なし | - | - |
| nftMintChallenge | Improper Input Validation | トラック候補なし | - | - |
| nullByteChallenge | Improper Input Validation | トラック候補なし | - | - |
| christmasSpecialChallenge | Injection | トラック候補なし | - | - |
| noSqlCommandChallenge | Injection | トラック候補なし | - | - |
| noSqlOrdersChallenge | Injection | トラック候補なし | - | - |
| noSqlReviewsChallenge | Injection | トラック候補なし | - | - |
| rceChallenge | Insecure Deserialization | トラック候補なし | - | - |
| rceOccupyChallenge | Insecure Deserialization | トラック候補なし | - | - |
| closeNotificationsChallenge | Miscellaneous | トラック候補なし | - | - |
| web3WalletChallenge | Miscellaneous | トラック候補なし | - | - |
| misplacedSignatureFileChallenge | Observability Failures | トラック候補なし | - | - |
| svgInjectionChallenge | Security Misconfiguration | トラック候補なし | - | - |
| privacyPolicyProofChallenge | Security through Obscurity | トラック候補なし | - | - |
| dataExportChallenge | Sensitive Data Exposure | トラック候補なし | - | - |
| directoryListingChallenge | Sensitive Data Exposure | トラック候補なし | - | - |
| forgottenBackupChallenge | Sensitive Data Exposure | トラック候補なし | - | - |
| forgottenDevBackupChallenge | Sensitive Data Exposure | トラック候補なし | - | - |
| nftUnlockChallenge | Sensitive Data Exposure | トラック候補なし | - | - |
| redirectChallenge | Unvalidated Redirects | トラック候補なし | - | - |
| redirectCryptoCurrencyChallenge | Unvalidated Redirects | トラック候補なし | - | - |
| lfrChallenge | Vulnerable Components | トラック候補なし | - | - |
| localXssChallenge | XSS | トラック候補なし | - | - |
| reflectedXssChallenge | XSS | トラック候補なし | - | - |
| usernameXssChallenge | XSS | トラック候補なし | - | - |
| videoXssChallenge | XSS | トラック候補なし | - | - |
| xssBonusChallenge | XSS | トラック候補なし | - | - |
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
| adminSectionChallenge | Broken Access Control | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| aiDebuggingChallenge | Broken Access Control | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/chat |
| basketAccessChallenge | Broken Access Control | 診断トラック候補あり | authorization-differential | http://127.0.0.1:53187/rest/basket/6 |
| basketManipulateChallenge | Broken Access Control | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/BasketItems |
| changeProductChallenge | Broken Access Control | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| feedbackChallenge | Broken Access Control | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| forgedFeedbackChallenge | Broken Access Control | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| ssrfChallenge | Broken Access Control | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| web3SandboxChallenge | Broken Access Control | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| captchaBypassChallenge | Broken Anti Automation | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| extraLanguageChallenge | Broken Anti Automation | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| resetPasswordMortyChallenge | Broken Anti Automation | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| changePasswordBenderChallenge | Broken Authentication | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/change-password?current= |
| ghostLoginChallenge | Broken Authentication | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| oauthUserPasswordChallenge | Broken Authentication | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| resetPasswordBenderChallenge | Broken Authentication | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| resetPasswordBjoernChallenge | Broken Authentication | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| resetPasswordBjoernOwaspChallenge | Broken Authentication | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| resetPasswordJimChallenge | Broken Authentication | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| weakPasswordChallenge | Broken Authentication | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| emptyUserRegistration | Improper Input Validation | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| freeDeluxeChallenge | Improper Input Validation | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/deluxe-membership |
| missingEncodingChallenge | Improper Input Validation | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| passwordRepeatChallenge | Improper Input Validation | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| registerAdminChallenge | Improper Input Validation | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| uploadSizeChallenge | Improper Input Validation | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| uploadTypeChallenge | Improper Input Validation | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| zeroStarsChallenge | Improper Input Validation | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| chatbotGreedyInjectionChallenge | Injection | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/chat |
| chatbotPromptInjectionChallenge | Injection | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/chat |
| dbSchemaChallenge | Injection | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/products/search?q= |
| ephemeralAccountantChallenge | Injection | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginAdminChallenge | Injection | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginBenderChallenge | Injection | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginJimChallenge | Injection | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| sstiChallenge | Injection | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| systemPromptExtractionChallenge | Injection | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| unionSqlInjectionChallenge | Injection | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/products/search?q= |
| yamlBombChallenge | Insecure Deserialization | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| privacyPolicyChallenge | Miscellaneous | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| scoreBoardChallenge | Miscellaneous | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| securityPolicyChallenge | Miscellaneous | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| accessLogDisclosureChallenge | Observability Failures | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| dlpPasswordSprayingChallenge | Observability Failures | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| exposedMetricsChallenge | Observability Failures | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| deprecatedInterfaceChallenge | Security Misconfiguration | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| errorHandlingChallenge | Security Misconfiguration | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| loginSupportChallenge | Security Misconfiguration | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| misplacedIacFiles | Security Misconfiguration | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| tokenSaleChallenge | Security through Obscurity | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| emailLeakChallenge | Sensitive Data Exposure | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/whoami?fields=email<br>http://127.0.0.1:53187/rest/user/whoami |
| exposedCredentialsChallenge | Sensitive Data Exposure | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| geoStalkingMetaChallenge | Sensitive Data Exposure | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| geoStalkingVisualChallenge | Sensitive Data Exposure | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| loginAmyChallenge | Sensitive Data Exposure | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| loginRapperChallenge | Sensitive Data Exposure | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/rest/user/login |
| passwordHashLeakChallenge | Sensitive Data Exposure | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/whoami?fields=email<br>http://127.0.0.1:53187/rest/user/whoami |
| resetPasswordUvoginChallenge | Sensitive Data Exposure | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/user/reset-password |
| retrieveBlueprintChallenge | Sensitive Data Exposure | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| fileWriteChallenge | Vulnerable Components | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| httpHeaderXssChallenge | XSS | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/saveLoginIp |
| persistedXssFeedbackChallenge | XSS | 診断トラック候補あり | api-schema | http://127.0.0.1:53187/api/Feedbacks<br>http://127.0.0.1:53187/api/Feedbacks/ |
| persistedXssUserChallenge | XSS | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/api/Users<br>http://127.0.0.1:53187/rest/user |
| restfulXssChallenge | XSS | 診断トラック候補あり | api-schema<br>zap-active | http://127.0.0.1:53187/api/Products<br>http://127.0.0.1:53187/rest/products |
| xxeDosChallenge | XXE | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
| xxeFileDisclosureChallenge | XXE | 診断トラック候補あり | zap-active | http://127.0.0.1:53187/rest/memories<br>http://127.0.0.1:53187/rest/memories/ |
