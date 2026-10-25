/**
 * 依存ゼロの xlsx (SpreadsheetML) reader。
 * workbook / rels / sharedStrings / worksheets を解釈し、sheet ごとに行 (string[]) を返す。
 * 事前検査で formula/error cell が 0 であることを確認済みのため、静的値のみを扱う。
 */
import { readZip } from './zip.ts';

export interface SheetRows {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
  /** rows[i] に対応する spreadsheet 上の行番号 (1-based)。空行の欠落でも座標がずれない。 */
  readonly rowNumbers: readonly number[];
}

export function readWorkbook(buffer: Buffer): readonly SheetRows[] {
  const zip = readZip(buffer);
  const shared = readSharedStrings(zip.get('xl/sharedStrings.xml')?.toString('utf8') ?? '');
  const workbookXml = requireEntry(zip, 'xl/workbook.xml').toString('utf8');
  const relsXml = requireEntry(zip, 'xl/_rels/workbook.xml.rels').toString('utf8');

  const relTargets = new Map<string, string>();
  for (const tag of allMatches(relsXml, /<Relationship\b[^>]*>/g)) {
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (id !== undefined && target !== undefined) {
      relTargets.set(id, target.replace(/^\//, ''));
    }
  }

  const sheets: SheetRows[] = [];
  for (const tag of allMatches(workbookXml, /<sheet\b[^>]*\/?>/g)) {
    const name = attribute(tag, 'name');
    const relationshipId = attribute(tag, 'r:id');
    if (name === undefined || relationshipId === undefined) {
      continue;
    }
    const target = relTargets.get(relationshipId);
    if (target === undefined) {
      continue;
    }
    const path = target.startsWith('xl/') ? target : `xl/${target}`;
    const sheetXml = zip.get(path);
    if (sheetXml === undefined) {
      continue;
    }
    const parsed = parseWorksheet(sheetXml.toString('utf8'), shared);
    sheets.push({ name, rows: parsed.rows, rowNumbers: parsed.rowNumbers });
  }
  return sheets;
}

function requireEntry(zip: Map<string, Buffer>, name: string): Buffer {
  const entry = zip.get(name);
  if (entry === undefined) {
    throw new Error(`xlsx: missing entry ${name}`);
  }
  return entry;
}

function readSharedStrings(xml: string): readonly string[] {
  const values: string[] = [];
  for (const si of allMatches(xml, /<si>([\s\S]*?)<\/si>/g)) {
    let text = '';
    for (const t of allMatches(si, /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
      text += decodeXmlEntities(t);
    }
    values.push(text);
  }
  return values;
}

function parseWorksheet(xml: string, shared: readonly string[]): { rows: readonly (readonly string[])[]; rowNumbers: readonly number[] } {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  const rowPattern = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  for (const match of xml.matchAll(rowPattern)) {
    const rowAttributes = match[1] ?? '';
    const rowInner = match[2] ?? '';
    const rowNumber = Number(attribute(rowAttributes, 'r') ?? String(rows.length + 1));
    const cells: string[] = [];
    const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    for (const cellMatch of rowInner.matchAll(cellPattern)) {
      const attributes = cellMatch[1] ?? '';
      const inner = cellMatch[2] ?? '';
      const reference = attribute(attributes, 'r') ?? '';
      const type = attribute(attributes, 't');
      let value = '';
      if (type === 's') {
        const index = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (index !== undefined) {
          value = shared[Number(index)] ?? '';
        }
      } else if (type === 'inlineStr') {
        const is = /<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '';
        for (const t of allMatches(is, /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
          value += decodeXmlEntities(t);
        }
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) {
          value = decodeXmlEntities(v);
        }
      }
      const column = columnIndex(reference.replace(/\d+$/, ''));
      if (column >= 0) {
        cells[column] = value;
      }
    }
    // 疎 row を密配列へ詰める (map は空 slot を skip するため Array.from を使う)。
    rows.push(Array.from(cells, (cell) => cell ?? ''));
    rowNumbers.push(rowNumber);
  }
  return { rows, rowNumbers };
}

/** A → 0, Z → 25, AA → 26。 */
function columnIndex(letters: string): number {
  if (!/^[A-Z]+$/.test(letters)) {
    return -1;
  }
  let index = 0;
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function allMatches(input: string, pattern: RegExp): readonly string[] {
  if (!pattern.global) {
    throw new Error('allMatches requires a global pattern');
  }
  const out: string[] = [];
  for (const match of input.matchAll(pattern)) {
    out.push(match[1] ?? match[0]);
  }
  return out;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
