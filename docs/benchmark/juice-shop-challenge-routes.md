# Juice Shop challenge 関連表面の観測状況 (参考値・機械導出)

- 導出ツール: `docs/benchmark/derive-challenge-routes.py` (solveIf 呼び出し位置×ルート定義)
- 判定ツール: `docs/benchmark/judge-challenge-reach.py` (クロール観測との交差)
- 観測ソース: クロール実測ログ (scopepilot2-juice-user-crawl.log, scopepilot2-juice-admin-crawl.log)

> この表は粗いソース対応付けと経路の前方一致による参考値です。challenge の到達・診断・検出・解決を証明しません。

判定結果: {"関連表面を観測": 103, "機械判定対象外 (client-side)": 13}

| key | category | status | endpoints | evidence |
|---|---|---|---|---|
| adminSectionChallenge | Broken Access Control | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| aiDebuggingChallenge | Broken Access Control | 関連表面を観測 | /rest/chat | GET / |
| basketAccessChallenge | Broken Access Control | 関連表面を観測 | /rest/basket/:id | GET / |
| basketManipulateChallenge | Broken Access Control | 関連表面を観測 | /api/BasketItems<br>/api/BasketItems/:id | GET / |
| changeProductChallenge | Broken Access Control | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| csrfChallenge | Broken Access Control | 関連表面を観測 | /profile | GET / |
| easterEggLevelOneChallenge | Broken Access Control | 関連表面を観測 | /ftp(?!/quarantine)/:file | GET / |
| feedbackChallenge | Broken Access Control | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| forgedFeedbackChallenge | Broken Access Control | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| forgedReviewChallenge | Broken Access Control | 関連表面を観測 | /rest/products/:id/reviews<br>/rest/products/reviews | GET / |
| ssrfChallenge | Broken Access Control | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| web3SandboxChallenge | Broken Access Control | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| captchaBypassChallenge | Broken Anti Automation | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| extraLanguageChallenge | Broken Anti Automation | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| resetPasswordMortyChallenge | Broken Anti Automation | 関連表面を観測 | /rest/user/reset-password | GET / |
| timingAttackChallenge | Broken Anti Automation | 関連表面を観測 | /rest/products/reviews | GET / |
| changePasswordBenderChallenge | Broken Authentication | 関連表面を観測 | /rest/user/change-password | GET / |
| ghostLoginChallenge | Broken Authentication | 関連表面を観測 | /rest/user/login | GET / |
| oauthUserPasswordChallenge | Broken Authentication | 関連表面を観測 | /rest/user/login | GET / |
| resetPasswordBenderChallenge | Broken Authentication | 関連表面を観測 | /rest/user/reset-password | GET / |
| resetPasswordBjoernChallenge | Broken Authentication | 関連表面を観測 | /rest/user/reset-password | GET / |
| resetPasswordBjoernOwaspChallenge | Broken Authentication | 関連表面を観測 | /rest/user/reset-password | GET / |
| resetPasswordJimChallenge | Broken Authentication | 関連表面を観測 | /rest/user/reset-password | GET / |
| twoFactorAuthUnsafeSecretStorageChallenge | Broken Authentication | 関連表面を観測 | /rest/2fa/status | GET / |
| weakPasswordChallenge | Broken Authentication | 関連表面を観測 | /rest/user/login | GET / |
| continueCodeChallenge | Cryptographic Issues | 関連表面を観測 | /rest/continue-code-findIt/apply/:continueCode<br>/rest/continue-code-fixIt/apply/:continueCode<br>/rest/continue-code/apply/:continueCode | GET / |
| easterEggLevelTwoChallenge | Cryptographic Issues | 関連表面を観測 | /the/devs/are/so/funny/they/hid/an/easter/egg/within/the/easter/egg | GET / |
| forgedCouponChallenge | Cryptographic Issues | 関連表面を観測 | /rest/basket/:id/checkout | GET / |
| premiumPaywallChallenge | Cryptographic Issues | 関連表面を観測 | /this/page/is/hidden/behind/an/incredibly/high/paywall/that/could/only/be/unlocked/by/sending/1btc/to/us | GET / |
| emptyUserRegistration | Improper Input Validation | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| freeDeluxeChallenge | Improper Input Validation | 関連表面を観測 | /rest/deluxe-membership | GET / |
| manipulateClockChallenge | Improper Input Validation | 関連表面を観測 | /rest/basket/:id/checkout | GET / |
| missingEncodingChallenge | Improper Input Validation | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| negativeOrderChallenge | Improper Input Validation | 関連表面を観測 | /rest/basket/:id/checkout | GET / |
| nftMintChallenge | Improper Input Validation | 関連表面を観測 | /rest/web3/nftMintListen<br>/rest/web3/walletNFTVerify | GET / |
| nullByteChallenge | Improper Input Validation | 関連表面を観測 | /ftp(?!/quarantine)/:file | GET / |
| passwordRepeatChallenge | Improper Input Validation | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| registerAdminChallenge | Improper Input Validation | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| uploadSizeChallenge | Improper Input Validation | 関連表面を観測 | /file-upload<br>/profile/image/file<br>/rest/memories | GET / |
| uploadTypeChallenge | Improper Input Validation | 関連表面を観測 | /file-upload<br>/profile/image/file<br>/rest/memories | GET / |
| zeroStarsChallenge | Improper Input Validation | 関連表面を観測 | /api/Feedbacks | GET / |
| chatbotGreedyInjectionChallenge | Injection | 関連表面を観測 | /rest/chat | GET / |
| chatbotPromptInjectionChallenge | Injection | 関連表面を観測 | /rest/chat | GET / |
| christmasSpecialChallenge | Injection | 関連表面を観測 | /rest/basket/:id/checkout | GET / |
| dbSchemaChallenge | Injection | 関連表面を観測 | /rest/products/search | GET / |
| ephemeralAccountantChallenge | Injection | 関連表面を観測 | /rest/user/login | GET / |
| loginAdminChallenge | Injection | 関連表面を観測 | /rest/user/login | GET / |
| loginBenderChallenge | Injection | 関連表面を観測 | /rest/user/login | GET / |
| loginJimChallenge | Injection | 関連表面を観測 | /rest/user/login | GET / |
| noSqlCommandChallenge | Injection | 関連表面を観測 | /rest/products/:id/reviews | GET / |
| noSqlOrdersChallenge | Injection | 関連表面を観測 | /rest/track-order/:id | GET / |
| noSqlReviewsChallenge | Injection | 関連表面を観測 | /rest/products/reviews | GET / |
| sstiChallenge | Injection | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| systemPromptExtractionChallenge | Injection | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| unionSqlInjectionChallenge | Injection | 関連表面を観測 | /rest/products/search | GET / |
| rceChallenge | Insecure Deserialization | 関連表面を観測 | /b2b/v2/orders | GET / |
| rceOccupyChallenge | Insecure Deserialization | 関連表面を観測 | /b2b/v2/orders | GET / |
| yamlBombChallenge | Insecure Deserialization | 関連表面を観測 | /file-upload<br>/profile/image/file<br>/rest/memories | GET / |
| closeNotificationsChallenge | Miscellaneous | 関連表面を観測 | /socket.io/ (websocket) | GET / |
| privacyPolicyChallenge | Miscellaneous | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| scoreBoardChallenge | Miscellaneous | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| securityPolicyChallenge | Miscellaneous | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| web3WalletChallenge | Miscellaneous | 関連表面を観測 | /rest/web3/walletExploitAddress | GET / |
| accessLogDisclosureChallenge | Observability Failures | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| dlpPasswordSprayingChallenge | Observability Failures | 関連表面を観測 | /rest/user/login | GET / |
| exposedMetricsChallenge | Observability Failures | 関連表面を観測 | /file-upload<br>/metrics<br>/profile/image/file<br>/rest/memories | GET / |
| misplacedSignatureFileChallenge | Observability Failures | 関連表面を観測 | /ftp(?!/quarantine)/:file | GET / |
| deprecatedInterfaceChallenge | Security Misconfiguration | 関連表面を観測 | /file-upload<br>/profile/image/file<br>/rest/memories | GET / |
| errorHandlingChallenge | Security Misconfiguration | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| loginSupportChallenge | Security Misconfiguration | 関連表面を観測 | /rest/user/login | GET / |
| misplacedIacFiles | Security Misconfiguration | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| svgInjectionChallenge | Security Misconfiguration | 関連表面を観測 | /socket.io/ (websocket) | GET / |
| privacyPolicyProofChallenge | Security through Obscurity | 関連表面を観測 | /we/may/also/instruct/you/to/refuse/all/reasonably/necessary/responsibility | GET / |
| tokenSaleChallenge | Security through Obscurity | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| dataExportChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/data-export | GET / |
| directoryListingChallenge | Sensitive Data Exposure | 関連表面を観測 | /ftp(?!/quarantine)/:file | GET / |
| emailLeakChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/whoami | GET / |
| exposedCredentialsChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/login | GET / |
| forgottenBackupChallenge | Sensitive Data Exposure | 関連表面を観測 | /ftp(?!/quarantine)/:file | GET / |
| forgottenDevBackupChallenge | Sensitive Data Exposure | 関連表面を観測 | /ftp(?!/quarantine)/:file | GET / |
| geoStalkingMetaChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/reset-password | GET / |
| geoStalkingVisualChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/reset-password | GET / |
| loginAmyChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/login | GET / |
| loginRapperChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/login | GET / |
| nftUnlockChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/web3/nftUnlocked<br>/rest/web3/submitKey | GET / |
| passwordHashLeakChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/whoami | GET / |
| resetPasswordUvoginChallenge | Sensitive Data Exposure | 関連表面を観測 | /rest/user/reset-password | GET / |
| retrieveBlueprintChallenge | Sensitive Data Exposure | 関連表面を観測 | /api/Feedbacks<br>/api/Users<br>/assets/i18n<br>/assets/public/images/padding | GET / |
| redirectChallenge | Unvalidated Redirects | 関連表面を観測 | /redirect | GET / |
| redirectCryptoCurrencyChallenge | Unvalidated Redirects | 関連表面を観測 | /redirect | GET / |
| fileWriteChallenge | Vulnerable Components | 関連表面を観測 | /file-upload<br>/profile/image/file<br>/rest/memories | GET / |
| lfrChallenge | Vulnerable Components | 関連表面を観測 | /dataerasure | GET / |
| httpHeaderXssChallenge | XSS | 関連表面を観測 | /rest/saveLoginIp | GET / |
| localXssChallenge | XSS | 関連表面を観測 | /socket.io/ (websocket) | GET / |
| persistedXssFeedbackChallenge | XSS | 関連表面を観測 | /api/Feedbacks | GET / |
| persistedXssUserChallenge | XSS | 関連表面を観測 | /api/Users<br>/rest/user | GET / |
| reflectedXssChallenge | XSS | 関連表面を観測 | /rest/track-order/:id | GET / |
| restfulXssChallenge | XSS | 関連表面を観測 | /api/Products<br>/rest/products | GET / |
| usernameXssChallenge | XSS | 関連表面を観測 | /profile | GET / |
| videoXssChallenge | XSS | 関連表面を観測 | /promotion<br>/video | GET / |
| xssBonusChallenge | XSS | 関連表面を観測 | /socket.io/ (websocket) | GET / |
| xxeDosChallenge | XXE | 関連表面を観測 | /file-upload<br>/profile/image/file<br>/rest/memories | GET / |
| xxeFileDisclosureChallenge | XXE | 関連表面を観測 | /file-upload<br>/profile/image/file<br>/rest/memories | GET / |
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

注意: solveIf の関連付けはミドルウェア経由になることがあり、endpoints がチャレンジの
本体表面と一致しない場合がある (verify.ts 系など)。それらは判定結果を参考値として扱う。
