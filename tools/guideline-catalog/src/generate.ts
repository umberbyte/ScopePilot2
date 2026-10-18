/**
 * 診断項目 Excel から版付き guideline catalog を生成する。`docs/design/27-security-guidelines.md` §3。
 *
 * - ガイドライン 6 sheet のデータ行 (計 769 件) を CheckCatalog 候補へ変換する。
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
  readonly schemaVersion: 'scopepilot2.catalog.v1';
  readonly generator: { readonly tool: '@scopepilot2/guideline-catalog'; readonly version: 1 };
  readonly source: CatalogSource & { readonly importerVersion: 1 };
  readonly guidelines: readonly {
    readonly sheet: string;
    readonly sourceNote: string;
    readonly checks: readonly GuidelineCheckRow[];
  }[];
  readonly zapRules: readonly ZapRuleRow[];
  readonly zapUnsupportedThemes: readonly ZapUnsupportedThemeRow[];
  readonly counts: { readonly guidelineChecks: number; readonly zapRules: number; readonly zapUnsupportedThemes: number };
  readonly catalogHash: string;
}

export function buildCatalog(sheets: readonly SheetRows[], source: CatalogSource): GuidelineCatalogFile {
  const guidelines = GUIDELINE_SHEET_NAMES.flatMap((sheetName) => {
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
    schemaVersion: 'scopepilot2.catalog.v1' as const,
    generator: { tool: '@scopepilot2/guideline-catalog' as const, version: 1 as const },
    source: { ...source, importerVersion: 1 as const },
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
