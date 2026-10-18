/**
 * CLI 引数 parser。`docs/detailed-design/f21-cli-automation.md` §4、design/19 §2。
 * 未知 option・競合 option は usage error (exit 2) にする (F21-UT-001)。
 * secret 値を argv へ渡すことを拒否し、error に値を出さない (F21-UT-007)。
 */

export interface ParsedCli {
  readonly command: 'simulate' | 'capabilities';
  readonly json: boolean;
  readonly injectUnknownScanTarget: boolean;
  readonly eventsFile?: string;
  readonly apiUrl?: string;
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
  if (command !== 'simulate' && command !== 'capabilities') {
    throw new UsageError(`unknown command: ${String(command)} (expected: simulate or capabilities)`);
  }

  let json: boolean | undefined;
  let injectUnknownScanTarget = false;
  let eventsFile: string | undefined;
  let eventsFileSeen = false;
  let apiUrl: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
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
      case '--api': {
        if (apiUrl !== undefined) {
          throw new UsageError('conflicting option: --api specified multiple times');
        }
        const value = rest[index + 1];
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
        const value = rest[index + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new UsageError('option --events requires a file path value');
        }
        eventsFile = value;
        eventsFileSeen = true;
        index += 1;
        break;
      }
      default:
        throw new UsageError(`unknown option: ${token}`);
    }
  }

  return {
    command,
    json: json ?? false,
    injectUnknownScanTarget,
    ...(eventsFile === undefined ? {} : { eventsFile }),
    ...(apiUrl === undefined ? {} : { apiUrl }),
  };
}
