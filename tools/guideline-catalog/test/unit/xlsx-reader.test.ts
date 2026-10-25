import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { describe, test } from 'node:test';
import { readWorkbook } from '../../src/xlsx.ts';
import { readZip } from '../../src/zip.ts';

/** テスト用の最小 ZIP 構築子 (格納 + deflate)。 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: readonly { name: string; data: Buffer; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const method = entry.deflate === true ? 8 : 0;
    const stored = entry.deflate === true ? deflateRawSync(entry.data) : entry.data;
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + stored.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

function buildSyntheticWorkbook(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0"?><Types/>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0"?><Relationships/>') },
    // workbook.xml は deflate を通り、method 8 経路も検証する。
    {
      name: 'xl/workbook.xml',
      deflate: true,
      data: Buffer.from(
        '<?xml version="1.0"?><workbook><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: Buffer.from(
        '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/sharedStrings.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><sst count="2"><si><t>共有1</t></si><si><r><t>Hello </t></r><r><t>&amp; World</t></r></si></sst>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><worksheet><sheetData>' +
          '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c><c r="C1" t="inlineStr"><is><t>直接&lt;値&gt;</t></is></c></row>' +
          '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"/></row>' +
          '<row r="3"><c r="C3" t="str"><v>計算値</v></c></row>' +
          '</sheetData></worksheet>',
      ),
    },
  ]);
}

describe('xlsx reader (依存ゼロ zip + SpreadsheetML)', () => {
  test('zip reader は格納・deflate の両エントリを読める', () => {
    const zip = readZip(buildSyntheticWorkbook());
    assert.ok(zip.get('xl/workbook.xml') !== undefined);
    assert.match(zip.get('xl/workbook.xml')?.toString('utf8') ?? '', /<sheets>/);
    assert.ok(zip.get('[Content_Types].xml') !== undefined);
  });

  test('workbook reader は shared string・数値・inline・空 cell・行番号を正しく解釈する', () => {
    const sheets = readWorkbook(buildSyntheticWorkbook());
    assert.equal(sheets.length, 1);
    const sheet = sheets[0];
    assert.equal(sheet?.name, 'S1');
    assert.deepEqual(sheet?.rowNumbers, [1, 2, 3]);
    assert.deepEqual(sheet?.rows[0], ['共有1', '42', '直接<値>']);
    // rich text の連結と entity 複号。
    assert.equal(sheet?.rows[1]?.[0], 'Hello & World');
    assert.equal(sheet?.rows[1]?.[1], '');
    // 参照の無い cell は行番号を保持したまま疎格納される。
    assert.deepEqual(sheet?.rows[2], ['', '', '計算値']);
  });
});
