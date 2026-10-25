/**
 * CLI 引数 parser。`docs/detailed-design/f21-cli-automation.md` §4、design/19 §2。
 * 未知 option・競合 option は usage error (exit 2) にする (F21-UT-001)。
 * secret 値を argv へ渡すことを拒否し、error に値を出さない (F21-UT-007)。
 */

export interface FuzzPosition {
  readonly name: string;
  readonly values: readonly string[];
}

export interface ParsedCli {
  readonly command: 'simulate' | 'capabilities' | 'events' | 'case-status' | 'fuzz';
  readonly json: boolean;
  readonly injectUnknownScanTarget: boolean;
  readonly eventsFile?: string;
  readonly apiUrl?: string;
  readonly since?: number;
  /** fuzz 専用: 対象 URL。 */
  readonly fuzzTarget?: string;
  /** fuzz 専用: positions (指定順)。 */
  readonly fuzzPositions?: readonly FuzzPosition[];
}

export class UsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** 秘密値らしき option 名。値を log に出さず option 名だけを案内する。 */
const SECRET_OPTION_PATTERN = /(?:secret|token|password|passphrase|api[-_]?key|credential)/i;

export function parseCli(argv: readonly string[]): ParsedCli {
  const [command, ...rest] = argv;
  if (command !== 'simulate' && command !== 'capabilities' && command !== 'events' && command !== 'case' && command !== 'fuzz') {
    throw new UsageError(`unknown command: ${String(command)} (expected: simulate, capabilities, events, case status, or fuzz)`);
  }
  let resolvedCommand: ParsedCli['command'];
  let optionTokens = rest;
  if (command === 'case') {
    const [sub, ...caseRest] = rest;
    if (sub !== 'status') {
      throw new UsageError(`unknown subcommand: ${String(sub)} (expected: case status)`);
    }
    resolvedCommand = 'case-status';
    optionTokens = caseRest;
  } else {
    resolvedCommand = command;
  }

  let json: boolean | undefined;
  let injectUnknownScanTarget = false;
  let eventsFile: string | undefined;
  let eventsFileSeen = false;
  let apiUrl: string | undefined;
  let since: number | undefined;
  let fuzzTarget: string | undefined;
  let fuzzPositions: FuzzPosition[] | undefined;

  for (let index = 0; index < optionTokens.length; index += 1) {
    const token = optionTokens[index];
    if (token === undefined) {
      break;
    }
    if (!token.startsWith('--')) {
      throw new UsageError(`unexpected argument: ${token}`);
    }
    if (SECRET_OPTION_PATTERN.test(token)) {
      // `=` 形式で値が連結されている場合を考え、案内には option 名だけを出す。
      const optionName = token.split('=')[0] ?? token;
      throw new UsageError(
        `secret values must not be passed as command-line options: ${optionName} (use stdin secret channel or an OS secret store reference)`,
      );
    }
    switch (token) {
      case '--json':
        if (json === true) {
          throw new UsageError('conflicting option: --json specified multiple times');
        }
        if (json === false) {
          throw new UsageError('conflicting options: --json and --human cannot be combined');
        }
        json = true;
        break;
      case '--human':
        if (json === true) {
          throw new UsageError('conflicting options: --json and --human cannot be combined');
        }
        json = false;
        break;
      case '--inject-unknown-target':
        injectUnknownScanTarget = true;
        break;
      case '--since': {
        if (since !== undefined) {
          throw new UsageError('conflicting option: --since specified multiple times');
        }
        const value = optionTokens[index + 1];
        if (value === undefined || value.startsWith('--') || !/^\d+$/.test(value)) {
          throw new UsageError('option --since requires a non-negative integer cursor');
        }
        since = Number(value);
        index += 1;
        break;
      }
      case '--api': {
        if (apiUrl !== undefined) {
          throw new UsageError('conflicting option: --api specified multiple times');
        }
        const value = optionTokens[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('option --api requires a base URL value (e.g. http://127.0.0.1:8787)');
        }
        const parsed = new URL(value);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new UsageError('option --api requires an http(s) base URL');
        }
        apiUrl = value;
        index += 1;
        break;
      }
      case '--events': {
        if (eventsFileSeen) {
          throw new UsageError('conflicting option: --events specified multiple times');
        }
        const value = optionTokens[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('option --events requires a file path value');
        }
        eventsFile = value;
        eventsFileSeen = true;
        index += 1;
        break;
      }
      case '--target': {
        if (resolvedCommand !== 'fuzz') {
          throw new UsageError(`unknown option: ${token}`);
        }
        if (fuzzTarget !== undefined) {
          throw new UsageError('conflicting option: --target specified multiple times');
        }
        const value = optionTokens[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('option --target requires a target URL value');
        }
        fuzzTarget = value;
        index += 1;
        break;
      }
      case '--position': {
        if (resolvedCommand !== 'fuzz') {
          throw new UsageError(`unknown option: ${token}`);
        }
        const value = optionTokens[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('option --position requires a value (name:v1,v2)');
        }
        const separator = value.indexOf(':');
        if (separator === -1) {
          throw new UsageError('option --position requires a value in the form name:v1,v2');
        }
        const name = value.slice(0, separator).trim();
        const values = value.slice(separator + 1).split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
        if (name === '' || values.length === 0) {
          throw new UsageError(`option --position requires a name and at least one value: ${value.split(':')[0] ?? ''}`);
        }
        fuzzPositions = [...(fuzzPositions ?? []), { name, values }];
        index += 1;
        break;
      }
      default:
        throw new UsageError(`unknown option: ${token}`);
    }
  }

  if (resolvedCommand === 'case-status' && apiUrl === undefined) {
    throw new UsageError('case status requires --api (the in-process harness has no case)');
  }
  if (resolvedCommand === 'fuzz') {
    if (fuzzTarget === undefined) {
      throw new UsageError('fuzz requires --target <url>');
    }
    if (fuzzPositions === undefined || fuzzPositions.length === 0) {
      throw new UsageError('fuzz requires at least one --position name:v1,v2');
    }
  }
  return {
    command: resolvedCommand,
    json: json ?? false,
    injectUnknownScanTarget,
    ...(eventsFile === undefined ? {} : { eventsFile }),
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(since === undefined ? {} : { since }),
    ...(fuzzTarget === undefined ? {} : { fuzzTarget }),
    ...(fuzzPositions === undefined ? {} : { fuzzPositions }),
  };
}
