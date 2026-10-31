/**
 * 診断項目 Excel から版付き guideline catalog を生成する。`docs/design/27-security-guidelines.md` §3。
 *
 * - 作業用 workbook のガイドライン 6 sheet (計 769 件) と、公式
 *   WebAppPentestGuidelines v1.2 の link-only 102項目を CheckCatalog 候補へ変換する。
 * - ZAP対応/非対応 sheet は DiagnosticTemplateCatalog 候補へ変換する。
 * - 出典・座標 (sheet, 行番号)・importer version・workbook sha256 を保持し、
 *   runtime で workbook を直接解釈しない。
 * - ペイロード・手順の長文列は本 catalog に複写せず source 座標で参照する
 *   (AGENTS.md「ペイロード集合の供給元と版を記録する」; 配布昇格は license 検証後)。
 * - 生成結果は決定的とし、catalog hash の安定を保証する。
 */
import { hashStable } from '@scopepilot2/contracts';
import type { SheetRows } from './xlsx.ts';

const GUIDELINE_SHEET_NAMES: readonly string[] = [
  'OWASP Top 10-2025',
  'OWASP ASVS 5.0',
  'OWASP WSTG 4.2',
  'OWASP AISVS 1.01',
  'OWASP CNAS Top 10',
  'デジタル庁 DS-221',
];
const ZAP_RULES_SHEET = 'ZAP診断ルールと実ペイロード';
const ZAP_UNSUPPORTED_SHEET = 'ZAP非対応項目と代替検証手段';
const PRIMARY_SOURCE_ID = 'scopepilot-working-workbook';
const WEBAPP_PENTEST_SOURCE_ID = 'webapp-pentest-guidelines-v1.2';
const WEBAPP_PENTEST_SOURCE_URL = 'https://github.com/WebAppPentestGuidelines/WebAppPentestGuidelines/blob/bcc4df46a7371ea0860e0d0900a22f89286ce5b8/WebAppPentestGuidelines/WebAppPentestGuidelines.xlsx';
const WEBAPP_PENTEST_SOURCE_SHA256 = 'bc25519a2b270e5c244cebdf26a08dd1387de7e08143f3ffbd71f2e8e5306dd8';
const WEBAPP_PENTEST_SOURCE_COMMIT = 'bcc4df46a7371ea0860e0d0900a22f89286ce5b8';
const WEBAPP_PENTEST_ITEM_COUNT = 102;

interface CoverageRange {
  readonly from: number;
  readonly to: number;
  readonly routes: readonly string[];
}

/**
 * 公式 v1.2 の No.1〜102 を、現在の ScopePilot 実行経路へ対応づける。
 * これは公式資料の改変版ではなく、原本行を参照する ScopePilot 側の review 済み対応表である。
 */
const WEBAPP_PENTEST_COVERAGE: readonly CoverageRange[] = [
  { from: 1, to: 6, routes: ['workflow:sqli-verify', 'zap:sql-injection'] },
  { from: 7, to: 14, routes: ['workflow:api-command-injection', 'zap:command-injection'] },
  { from: 15, to: 16, routes: ['zap:crlf-response-splitting'] },
  { from: 17, to: 17, routes: ['zap-unsupported:14'] },
  { from: 18, to: 24, routes: ['workflow:xss-reflected', 'workflow:xss-stored', 'workflow:xss-dom', 'zap:xss'] },
  { from: 25, to: 26, routes: ['zap-unsupported:28'] },
  { from: 27, to: 28, routes: ['zap-unsupported:15'] },
  { from: 29, to: 35, routes: ['workflow:lfi', 'zap:path-traversal'] },
  { from: 36, to: 46, routes: ['workflow:file-upload', 'zap-unsupported:19'] },
  { from: 47, to: 52, routes: ['zap:xxe'] },
  { from: 53, to: 55, routes: ['workflow:open-redirect', 'zap:open-redirect'] },
  { from: 56, to: 56, routes: ['zap-unsupported:18'] },
  { from: 57, to: 60, routes: ['zap-unsupported:16'] },
  { from: 61, to: 61, routes: ['zap-unsupported:27'] },
  { from: 62, to: 63, routes: ['zap:clickjacking'] },
  { from: 64, to: 65, routes: ['zap-unsupported:1'] },
  { from: 66, to: 67, routes: ['zap-unsupported:8'] },
  { from: 68, to: 68, routes: ['workflow:brute-force', 'zap-unsupported:5'] },
  { from: 69, to: 73, routes: ['zap-unsupported:3'] },
  { from: 74, to: 75, routes: ['zap-unsupported:4'] },
  { from: 76, to: 78, routes: ['workflow:weak-session', 'zap-unsupported:8'] },
  { from: 79, to: 81, routes: ['workflow:authorization-bypass', 'workflow:bac-open-access', 'zap-unsupported:10'] },
  { from: 82, to: 84, routes: ['workflow:csrf-password', 'zap-unsupported:12'] },
  { from: 85, to: 97, routes: ['zap:passive-information-disclosure', 'zap-unsupported:29'] },
  { from: 98, to: 98, routes: ['zap:directory-listing'] },
  { from: 99, to: 100, routes: ['zap-unsupported:25'] },
  { from: 101, to: 101, routes: ['zap:forced-browsing', 'manual-review:published-surface'] },
  { from: 102, to: 102, routes: ['nuclei:known-vulnerabilities', 'zap:technology-detection'] },
];

export interface CatalogSource {
  readonly workbookPath: string;
  readonly sha256: string;
}

export interface GuidelineCheckRow {
  readonly sheet: string;
  readonly row: number;
  readonly no: string;
  readonly chapter: string;
  readonly itemId: string;
  readonly requirement: string;
  readonly checkItem: string;
  readonly method: string;
  readonly suspectedBehavior: string;
  readonly safeState: string;
  readonly sourceId?: string;
  readonly sourceUrl?: string;
  readonly coverageRoutes?: readonly string[];
}

export interface CatalogSourceRecord {
  readonly id: string;
  readonly kind: 'workbook' | 'upstream-link-only';
  readonly version: string;
  readonly sourceUrl: string;
  readonly workbookPath: string;
  readonly sha256: string;
  readonly importerVersion: number;
  readonly itemCount: number;
  readonly repositoryCommit?: string;
  readonly publishedAt?: string;
}

export interface ZapRuleRow {
  readonly sheet: string;
  readonly row: number;
  readonly no: string;
  readonly kind: string;
  readonly ruleId: string;
  readonly name: string;
  readonly target: string;
  readonly suspectedBehavior: string;
}

export interface ZapUnsupportedThemeRow {
  readonly sheet: string;
  readonly row: number;
  readonly no: string;
  readonly theme: string;
  readonly targetItems: string;
  readonly goal: string;
  readonly zapStatus: string;
  readonly tools: string;
  readonly suspectedBehavior: string;
}

export interface GuidelineCatalogFile {
  readonly schemaVersion: 'scopepilot2.catalog.v2';
  readonly generator: { readonly tool: '@scopepilot2/guideline-catalog'; readonly version: 2 };
  readonly source: CatalogSource & { readonly importerVersion: 1 };
  readonly sources: readonly CatalogSourceRecord[];
  readonly guidelines: readonly {
    readonly sheet: string;
    readonly sourceNote: string;
    readonly sourceId: string;
    readonly version: string;
    readonly sourceUrl: string;
    readonly linkOnly: boolean;
    readonly checks: readonly GuidelineCheckRow[];
  }[];
  readonly zapRules: readonly ZapRuleRow[];
  readonly zapUnsupportedThemes: readonly ZapUnsupportedThemeRow[];
  readonly counts: { readonly guidelineChecks: number; readonly zapRules: number; readonly zapUnsupportedThemes: number };
  readonly catalogHash: string;
}

export function buildCatalog(sheets: readonly SheetRows[], source: CatalogSource): GuidelineCatalogFile {
  const workbookGuidelines = GUIDELINE_SHEET_NAMES.flatMap((sheetName) => {
    const sheet = sheets.find((candidate) => candidate.name === sheetName);
    if (sheet === undefined) {
      throw new Error(`catalog: guideline sheet not found: ${sheetName}`);
    }
    const { headerIndex, dataRows } = splitDataRows(sheet);
    const sourceNote = (sheet.rows[headerIndex - 1] ?? []).join(' ');
    return [
      {
        sheet: sheetName,
        sourceNote,
        sourceId: PRIMARY_SOURCE_ID,
        version: 'scopepilot-working-copy-2026-10-18',
        sourceUrl: '',
        linkOnly: false,
        checks: dataRows.map(({ index }) => {
          const row = sheet.rows[index] ?? [];
          return {
            sheet: sheetName,
            row: sheet.rowNumbers[index] ?? index + 1,
            no: row[0] ?? '',
            chapter: row[1] ?? '',
            itemId: row[2] ?? '',
            requirement: row[3] ?? '',
            checkItem: row[4] ?? '',
            method: row[5] ?? '',
            suspectedBehavior: row[6] ?? '',
            safeState: row[7] ?? '',
          };
        }),
      },
    ];
  });
  const webAppPentestGuideline = buildWebAppPentestGuideline();
  const guidelines = [...workbookGuidelines, webAppPentestGuideline];

  const rulesSheet = requireSheet(sheets, ZAP_RULES_SHEET);
  const unsupportedSheet = requireSheet(sheets, ZAP_UNSUPPORTED_SHEET);

  const zapRules = splitDataRows(rulesSheet).dataRows.map(({ index }) => {
    const row = rulesSheet.rows[index] ?? [];
    return {
      sheet: ZAP_RULES_SHEET,
      row: rulesSheet.rowNumbers[index] ?? index + 1,
      no: row[0] ?? '',
      kind: row[1] ?? '',
      ruleId: row[2] ?? '',
      name: row[3] ?? '',
      target: row[4] ?? '',
      // ペイロード (E=5)・手順 (G=6) 列は source 座標で参照し複写しない。
      suspectedBehavior: row[7] ?? '',
    };
  });

  const zapUnsupportedThemes = splitDataRows(unsupportedSheet).dataRows.map(({ index }) => {
    const row = unsupportedSheet.rows[index] ?? [];
    return {
      sheet: ZAP_UNSUPPORTED_SHEET,
      row: unsupportedSheet.rowNumbers[index] ?? index + 1,
      no: row[0] ?? '',
      theme: row[1] ?? '',
      targetItems: row[2] ?? '',
      goal: row[3] ?? '',
      zapStatus: row[4] ?? '',
      // 手順 (F=5) 列は source 座標で参照し複写しない。
      tools: row[6] ?? '',
      suspectedBehavior: row[7] ?? '',
    };
  });

  const body = {
    schemaVersion: 'scopepilot2.catalog.v2' as const,
    generator: { tool: '@scopepilot2/guideline-catalog' as const, version: 2 as const },
    source: { ...source, importerVersion: 1 as const },
    sources: [
      {
        id: PRIMARY_SOURCE_ID,
        kind: 'workbook' as const,
        version: 'scopepilot-working-copy-2026-10-18',
        sourceUrl: '',
        workbookPath: source.workbookPath,
        sha256: source.sha256,
        importerVersion: 1,
        itemCount: workbookGuidelines.reduce((sum, guideline) => sum + guideline.checks.length, 0),
      },
      {
        id: WEBAPP_PENTEST_SOURCE_ID,
        kind: 'upstream-link-only' as const,
        version: '1.2',
        sourceUrl: WEBAPP_PENTEST_SOURCE_URL,
        workbookPath: 'WebAppPentestGuidelines/WebAppPentestGuidelines.xlsx',
        sha256: WEBAPP_PENTEST_SOURCE_SHA256,
        importerVersion: 1,
        itemCount: WEBAPP_PENTEST_ITEM_COUNT,
        repositoryCommit: WEBAPP_PENTEST_SOURCE_COMMIT,
        publishedAt: '2022-02-16',
      },
    ],
    guidelines,
    zapRules,
    zapUnsupportedThemes,
    counts: {
      guidelineChecks: guidelines.reduce((sum, guideline) => sum + guideline.checks.length, 0),
      zapRules: zapRules.length,
      zapUnsupportedThemes: zapUnsupportedThemes.length,
    },
  };
  return { ...body, catalogHash: hashStable('scopepilot2.catalog', body) };
}

function buildWebAppPentestGuideline(): GuidelineCatalogFile['guidelines'][number] {
  const checks: GuidelineCheckRow[] = [];
  for (let no = 1; no <= WEBAPP_PENTEST_ITEM_COUNT; no += 1) {
    const coverage = WEBAPP_PENTEST_COVERAGE.find((candidate) => no >= candidate.from && no <= candidate.to);
    if (coverage === undefined) {
      throw new Error(`catalog: WebAppPentestGuidelines v1.2 No.${String(no)} has no ScopePilot coverage route`);
    }
    const itemId = `WAPG-1.2-${String(no).padStart(3, '0')}`;
    checks.push({
      sheet: 'WebAppPentestGuidelines v1.2',
      row: no + 1,
      no: String(no),
      chapter: 'WebAppPentestGuidelines v1.2',
      itemId,
      requirement: `公式ガイドライン No.${String(no)}（本文は公式Excel参照）`,
      checkItem: itemId,
      method: '公式Excelの該当行を参照し、ScopePilot coverage routeの承認済み検査を実行する',
      suspectedBehavior: '公式Excelの「脆弱性があると疑われる挙動」を参照',
      safeState: '公式Excelの問題なし判定を参照',
      sourceId: WEBAPP_PENTEST_SOURCE_ID,
      sourceUrl: WEBAPP_PENTEST_SOURCE_URL,
      coverageRoutes: coverage.routes,
    });
  }
  return {
    sheet: 'WebAppPentestGuidelines v1.2',
    sourceNote: `公式第1.2版（2022-02-16公開、commit ${WEBAPP_PENTEST_SOURCE_COMMIT}）。license未確認のため本文・payloadは再配布せず、No.1〜102の安定ID、原本行、公式link、ScopePilot coverage routeだけを収録する。`,
    sourceId: WEBAPP_PENTEST_SOURCE_ID,
    version: '1.2',
    sourceUrl: WEBAPP_PENTEST_SOURCE_URL,
    linkOnly: true,
    checks,
  };
}

function requireSheet(sheets: readonly SheetRows[], name: string): SheetRows {
  const sheet = sheets.find((candidate) => candidate.name === name);
  if (sheet === undefined) {
    throw new Error(`catalog: sheet not found: ${name}`);
  }
  return sheet;
}

/** 先頭列が 'No' の行を header とし、以降の「先頭列が空でない行」をデータ行とする。 */
function splitDataRows(sheet: SheetRows): { headerIndex: number; dataRows: readonly { index: number }[] } {
  let headerIndex = -1;
  for (let index = 0; index < sheet.rows.length; index += 1) {
    if ((sheet.rows[index]?.[0] ?? '') === 'No') {
      headerIndex = index;
      break;
    }
  }
  if (headerIndex < 0) {
    throw new Error(`catalog: header row (No) not found in sheet ${sheet.name}`);
  }
  const dataRows: { index: number }[] = [];
  for (let index = headerIndex + 1; index < sheet.rows.length; index += 1) {
    if ((sheet.rows[index]?.[0] ?? '').trim() !== '') {
      dataRows.push({ index });
    }
  }
  return { headerIndex, dataRows };
}
