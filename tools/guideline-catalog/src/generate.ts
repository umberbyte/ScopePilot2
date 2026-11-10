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
import { buildCoverageRoutes } from './coverage.ts';
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
  readonly schemaVersion: 'scopepilot2.catalog.v3';
  readonly generator: { readonly tool: '@scopepilot2/guideline-catalog'; readonly version: 3 };
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
  readonly coverageRoutes: readonly import('@scopepilot2/contracts').GuidelineCoverageRoute[];
  readonly catalogContentHash: string;
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
    schemaVersion: 'scopepilot2.catalog.v3' as const,
    generator: { tool: '@scopepilot2/guideline-catalog' as const, version: 3 as const },
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
  // Bind routes to catalog content before hashing the complete artifact (no circular hash).
  const catalogContentHash = hashStable('scopepilot2.catalog-content.v3', body);
  const complete = { ...body, catalogContentHash, coverageRoutes: buildCoverageRoutes(guidelines, catalogContentHash) };
  return { ...complete, catalogHash: hashStable('scopepilot2.catalog', complete) };
}

function buildWebAppPentestGuideline(): GuidelineCatalogFile['guidelines'][number] {
  const checks: GuidelineCheckRow[] = [];
  for (let no = 1; no <= WEBAPP_PENTEST_ITEM_COUNT; no += 1) {
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
