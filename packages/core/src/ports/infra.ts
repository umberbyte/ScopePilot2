/** 決定的テストのための注入点。`docs/detailed-design/01-system-components.md` 5章。 */
import { hashStable } from '@scopepilot2/contracts';

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

export interface StoredEvidence {
  readonly evidenceId: string;
  readonly sha256: string;
  readonly label: string;
  readonly savedAt: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** 証跡の保存 port。原本は hash 参照し、保存成功後だけ event を公開する (SYS-UT-005)。 */
export interface EvidenceStorePort {
  saveText(label: string, content: string, metadata?: Readonly<Record<string, string>>): Promise<StoredEvidence>;
}

/** 固定時計。fixture での決定的実行に使う。 */
export class FixedClock implements Clock {
  private readonly isoTimes: readonly string[];
  private index = 0;

  constructor(isoTimes: readonly string[]) {
    if (isoTimes.length === 0) {
      throw new Error('FixedClock requires at least one timestamp');
    }
    this.isoTimes = isoTimes;
  }

  now(): Date {
    const value = this.isoTimes[Math.min(this.index, this.isoTimes.length - 1)];
    if (value === undefined) {
      throw new Error('FixedClock has no timestamps');
    }
    this.index += 1;
    return new Date(value);
  }
}

/** 連番 ID。fixture で決定的な ID を作る。 */
export class SequentialIdGenerator implements IdGenerator {
  private counters = new Map<string, number>();
  next(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}-${String(next).padStart(4, '0')}`;
  }
}

/** 案件ローカルの in-memory 証拠保存。実装は storage パッケージが SQLite で置き換える。 */
export class InMemoryEvidenceStore implements EvidenceStorePort {
  private sequence = 0;
  private readonly records: StoredEvidence[] = [];

  async saveText(label: string, content: string, metadata?: Readonly<Record<string, string>>): Promise<StoredEvidence> {
    this.sequence += 1;
    const record: StoredEvidence = {
      evidenceId: `evidence-${String(this.sequence).padStart(4, '0')}`,
      sha256: hashStable('scopepilot2.evidence', content),
      label,
      savedAt: new Date().toISOString(),
      ...(metadata === undefined || Object.keys(metadata).length === 0 ? {} : { metadata }),
    };
    this.records.push(record);
    return record;
  }

  list(): readonly StoredEvidence[] {
    return [...this.records];
  }
}
