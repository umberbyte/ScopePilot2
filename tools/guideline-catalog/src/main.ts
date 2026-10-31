#!/usr/bin/env node
/**
 * カタログ生成 CLI。
 * --inspect: sheet 構造 (行列数・先頭行) を stderr 構造化出力する。
 * 既定: 版付きカタログ JSON を stdout へ 1 つだけ出力する。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { readWorkbook } from './xlsx.ts';
import { buildCatalog } from './generate.ts';

const workbookPath = process.argv[2];
if (workbookPath === undefined || process.argv.includes('--help')) {
  process.stderr.write('usage: node main.ts <workbook.xlsx> [--inspect] [--output <catalog.json>]\n');
  process.exitCode = 2;
} else if (process.argv.includes('--inspect')) {
  const buffer = readFileSync(workbookPath);
  const sheets = readWorkbook(buffer);
  const inspect = sheets.map((sheet) => ({
    name: sheet.name,
    rowCount: sheet.rows.length,
    header: sheet.rows[0] ?? [],
    sample: sheet.rows.slice(1, 3),
  }));
  process.stdout.write(`${JSON.stringify({ sheets: inspect }, null, 2)}\n`);
} else {
  const buffer = readFileSync(workbookPath);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const catalog = buildCatalog(readWorkbook(buffer), { workbookPath, sha256 });
  const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
  const outputIndex = process.argv.indexOf('--output');
  const outputPath = outputIndex < 0 ? undefined : process.argv[outputIndex + 1];
  if (outputIndex >= 0 && outputPath === undefined) {
    throw new Error('catalog: --output requires a path');
  }
  if (outputPath === undefined) {
    process.stdout.write(serialized);
  } else {
    writeFileSync(outputPath, serialized, 'utf8');
  }
}
