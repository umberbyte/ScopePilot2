/**
 * アクティビティパネルの状態管理フック。
 *
 * TODO: P0 JobRegistry マージ後は /api/jobs と /api/jobs/events の SSE を使う。
 * 現在は既存の /api/events と /api/runs/interrupted を使う暫定実装。
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { ActivityEvent, ActivityFilter, ActivityJobSummary } from './activity-panel-types.ts';
import type { BaselineFlowEvent } from '@scopepilot2/contracts';

interface UseActivityPanelOptions {
  readonly apiBase: string;
  readonly currentJobId?: string;
  readonly currentRunId?: string;
}

interface UseActivityPanelResult {
  readonly events: readonly ActivityEvent[];
  readonly jobs: readonly ActivityJobSummary[];
  readonly filter: ActivityFilter;
  readonly setFilter: (filter: ActivityFilter) => void;
  readonly collapsed: boolean;
  readonly setCollapsed: (collapsed: boolean) => void;
  readonly error: Error | null;
}

/**
 * BaselineFlowEvent を ActivityEvent に変換 (暫定)
 */
const convertToActivityEvent = (event: BaselineFlowEvent & { eventId: number }, index: number): ActivityEvent => {
  const at = event.at;
  let level: 'debug' | 'info' | 'warn' | 'error' = 'info';
  let category: ActivityEvent['category'] = 'other';
  let message = '';
  let url: string | undefined;
  let runId: string | undefined;
  let findingId: string | undefined;

  switch (event.type) {
    case 'RunStarted':
      category = 'lifecycle';
      level = 'info';
      message = `実行開始 (plan ${event.planHash.substring(0, 8)})`;
      runId = event.runId;
      break;

    case 'RunCompleted':
      category = 'lifecycle';
      level = 'info';
      message = `実行完了 (${event.stopReason})`;
      runId = event.runId;
      break;

    case 'EgressDenied':
      category = 'egress-denied';
      level = 'warn';
      message = `${event.url} を拒否（${event.reason}）`;
      url = event.url;
      break;

    case 'FindingsImported':
      category = 'other';
      level = 'info';
      message = `所見 ${event.importedCount} 件を取込 (${event.source}${event.engineVersion ? ` ${event.engineVersion}` : ''})`;
      break;

    case 'FindingStatusChanged':
      category = 'other';
      level = 'info';
      message = `所見の状態変更: ${event.from} → ${event.to}`;
      findingId = event.findingId;
      break;

    case 'CaseCreated':
      category = 'lifecycle';
      level = 'info';
      message = '案件作成';
      break;

    case 'CaseScopeUpdated':
      category = 'lifecycle';
      level = 'info';
      message = `スコープ更新 (${event.narrowed ? '縮小' : '拡大'})`;
      break;

    case 'PlanConfirmed':
      category = 'lifecycle';
      level = 'info';
      message = `計画確認 (${event.planHash.substring(0, 8)})`;
      break;

    case 'LoginCompleted':
      category = 'lifecycle';
      level = event.authenticated ? 'info' : 'warn';
      message = `ログイン${event.authenticated ? '成功' : '失敗'} (role: ${event.role})`;
      break;

    case 'FuzzRunCompleted':
      category = 'lifecycle';
      level = 'info';
      message = `Fuzzer 完了: ${event.targetUrl} (${event.sent}/${event.total})`;
      runId = event.runId;
      url = event.targetUrl;
      break;

    case 'DocumentHintsRegistered':
      category = 'other';
      level = 'info';
      message = `文書ヒント登録: ${event.documentLabel} (${event.acceptedUrlCount}/${event.urlCount} URL)`;
      break;

    case 'ApiSpecImported':
      category = 'other';
      level = 'info';
      message = `API 定義取込: ${event.documentLabel} (${event.endpointCount} endpoints)`;
      break;

    default:
      category = 'other';
      level = 'debug';
      message = event.type;
  }

  return {
    seq: event.eventId,
    at,
    level,
    category,
    source: 'scopepilot',
    message,
    ...(url === undefined ? {} : { url }),
    ...(runId === undefined ? {} : { runId }),
    ...(findingId === undefined ? {} : { findingId }),
  };
};

/**
 * アクティビティパネルの状態を管理するフック。
 */
export const useActivityPanel = (options: UseActivityPanelOptions): UseActivityPanelResult => {
  const { apiBase, currentJobId, currentRunId } = options;
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [jobs, setJobs] = useState<ActivityJobSummary[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>({
    scope: currentJobId ? 'this-job' : 'all-jobs',
    level: 'info',
    ...(currentJobId === undefined ? {} : { jobId: currentJobId }),
    ...(currentRunId === undefined ? {} : { runId: currentRunId }),
  });
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const lastEventId = useRef<number>(0);
  const pollTimerRef = useRef<number | null>(null);

  // イベントの取得 (暫定: polling ベース。P0 後は SSE に移行)
  const fetchEvents = useCallback(async () => {
    try {
      const url = `${apiBase}/api/events${lastEventId.current > 0 ? `?since=${lastEventId.current}` : ''}`;
      const response = await fetch(url, {
        headers: { Accept: 'application/x-ndjson' },
      });

      if (!response.ok) {
        throw new Error(`GET /api/events failed: HTTP ${response.status}`);
      }

      const text = await response.text();
      if (!text.trim()) {
        return;
      }

      const lines = text.trim().split('\n');
      const newEvents: ActivityEvent[] = [];

      for (const line of lines) {
        try {
          const raw = JSON.parse(line) as BaselineFlowEvent & { eventId: number };
          if (raw.eventId > lastEventId.current) {
            lastEventId.current = raw.eventId;
          }
          const event = convertToActivityEvent(raw, newEvents.length);
          newEvents.push(event);
        } catch (parseError) {
          console.warn('Failed to parse event line:', line, parseError);
        }
      }

      if (newEvents.length > 0) {
        setEvents((prev) => {
          const combined = [...prev, ...newEvents];
          // 最大 10,000 イベントを保持
          return combined.slice(-10000);
        });
      }
    } catch (err) {
      console.error('Failed to fetch events:', err);
      setError(err as Error);
    }
  }, [apiBase]);

  // TODO: P0 後は /api/jobs を使う
  // 現在は /api/runs/interrupted のみを暫定で使用
  const fetchJobs = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase}/api/runs/interrupted`);
      if (!response.ok) {
        throw new Error(`GET /api/runs/interrupted failed: HTTP ${response.status}`);
      }

      const data = await response.json() as { interrupted: Array<{ runId: string; planHash: string; state: string; startedAt: string }> };

      // 暫定: 実行中ジョブの情報は events から推測
      // P0 後は /api/jobs で取得
      const runIds = new Set<string>();
      events.forEach((e) => {
        if (e.runId && e.category === 'lifecycle' && e.message.includes('実行開始')) {
          runIds.add(e.runId);
        }
      });

      const activeJobs: ActivityJobSummary[] = Array.from(runIds).map((runId) => {
        const startEvent = events.find((e) => e.runId === runId && e.message.includes('実行開始'));
        const endEvent = events.find((e) => e.runId === runId && e.message.includes('実行完了'));

        return {
          jobId: runId,
          kind: 'unknown',
          label: `Run ${runId.substring(0, 8)}`,
          state: endEvent ? 'completed' : 'running',
          startedAt: startEvent?.at || new Date().toISOString(),
          ...(endEvent?.at === undefined ? {} : { endedAt: endEvent.at }),
          counters: {
            requestsSent: 0,  // TODO: P0 後に実装
            deniedByScope: events.filter((e) => e.runId === runId && e.category === 'egress-denied').length,
            errors: events.filter((e) => e.runId === runId && e.category === 'error').length,
            warnings: events.filter((e) => e.runId === runId && e.level === 'warn').length,
          },
        };
      });

      setJobs(activeJobs);
    } catch (err) {
      console.error('Failed to fetch jobs:', err);
      setError(err as Error);
    }
  }, [apiBase, events]);

  // Polling (暫定実装。P0 後は SSE に置き換え)
  useEffect(() => {
    fetchEvents();
    fetchJobs();

    pollTimerRef.current = window.setInterval(() => {
      fetchEvents();
      fetchJobs();
    }, 2000);

    return () => {
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, [fetchEvents, fetchJobs]);

  // currentJobId が変わったらフィルタを更新
  useEffect(() => {
    setFilter((prev: ActivityFilter) => {
      const { jobId: _j, runId: _r, ...rest } = prev;
      return {
        ...rest,
        scope: currentJobId ? 'this-job' : 'all-jobs',
        ...(currentJobId === undefined ? {} : { jobId: currentJobId }),
        ...(currentRunId === undefined ? {} : { runId: currentRunId }),
      };
    });
  }, [currentJobId, currentRunId]);

  return {
    events,
    jobs,
    filter,
    setFilter,
    collapsed,
    setCollapsed,
    error,
  };
};
