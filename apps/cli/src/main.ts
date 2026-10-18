#!/usr/bin/env node
/**
 * `scopepilot` CLI entry point。design/19 §2。
 * main(argv, writers) は検証可能な形で結果 (exit code) を返し、実行は process stream へ書く。
 * `--events <file>` 指定時は進捗 NDJSON を stderr ではなく同 file へ出す。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseCli, UsageError } from './cli-parser.ts';
import { OutputFormatter, type OutputWriters } from './output-formatter.ts';
import { runSimulate } from './simulate.ts';
import { runCapabilities } from './capabilities.ts';

export async function main(argv: readonly string[], writers?: OutputWriters): Promise<number> {
  const boundWriters: OutputWriters = writers ?? {
    stdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };

  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      boundWriters.stderr(`usage error: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }

  if (parsed.command === 'capabilities') {
    return await runCapabilities(
      parsed.apiUrl === undefined ? {} : { apiUrl: parsed.apiUrl },
      boundWriters,
    );
  }
  const output = new OutputFormatter({ json: parsed.json }, boundWriters);
  const outcome = await runSimulate({
    ...(parsed.injectUnknownScanTarget ? { injectUnknownScanTarget: true } : {}),
    ...(parsed.apiUrl === undefined ? {} : { apiUrl: parsed.apiUrl }),
  });
  if (parsed.eventsFile === undefined) {
    for (const event of outcome.events) {
      output.progress(event);
    }
  } else {
    writeFileSync(parsed.eventsFile, '');
    for (const event of outcome.events) {
      appendFileSync(parsed.eventsFile, `${JSON.stringify(event)}\n`);
    }
  }
  output.result(outcome.summary);
  return outcome.exitCode;
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].replaceAll('\\', '/').endsWith('apps/cli/src/main.ts');
if (invokedDirectly) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
