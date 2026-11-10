/**
 * 共通アクティビティパネル。
 * docs/design/40-advanced-mode-redesign.md §5.4 実装。
 *
 * 全 Advanced 画面の下部に置く共通パネル (ZAP の下部タブ、IDE の出力パネル相当)。
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  makeStyles,
  tokens,
  Tab,
  TabList,
  Button,
  Input,
  Dropdown,
  Option,
  Text,
  Badge,
  shorthands,
  Switch,
  type SelectTabEvent,
  type SelectTabData,
} from '@fluentui/react-components';
import {
  ChevronUp20Regular,
  ChevronDown20Regular,
  Search20Regular,
  Dismiss20Regular,
} from '@fluentui/react-icons';
import type {
  ActivityEvent,
  ActivityFilter,
  ActivityJobSummary,
  ActivityTab,
  ActivityEventCategory,
} from './activity-panel-types.ts';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('8px', '16px'),
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground2,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('12px'),
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
  },
  title: {
    fontWeight: tokens.fontWeightSemibold,
    fontSize: tokens.fontSizeBase300,
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('8px'),
    ...shorthands.padding('8px', '16px'),
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  searchBox: {
    minWidth: '200px',
  },
  content: {
    display: 'flex',
    flexDirection: 'column',
    ...shorthands.overflow('auto'),
    minHeight: '200px',
    maxHeight: '400px',
  },
  logLine: {
    display: 'flex',
    ...shorthands.gap('12px'),
    ...shorthands.padding('6px', '16px'),
    fontSize: tokens.fontSizeBase200,
    fontFamily: tokens.fontFamilyMonospace,
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  timestamp: {
    color: tokens.colorNeutralForeground3,
    minWidth: '72px',
  },
  level: {
    minWidth: '48px',
    fontWeight: tokens.fontWeightSemibold,
  },
  source: {
    color: tokens.colorNeutralForeground2,
    minWidth: '80px',
  },
  message: {
    flex: 1,
  },
  jobRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...shorthands.padding('8px', '16px'),
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: tokens.colorNeutralBackground2,
    },
  },
  jobLeft: {
    display: 'flex',
    flexDirection: 'column',
    ...shorthands.gap('4px'),
  },
  jobRight: {
    display: 'flex',
    alignItems: 'center',
    ...shorthands.gap('12px'),
  },
  empty: {
    ...shorthands.padding('32px'),
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
});

const getLevelColor = (level: 'debug' | 'info' | 'warn' | 'error'): string => {
  switch (level) {
    case 'error':
      return tokens.colorPaletteRedForeground1;
    case 'warn':
      return tokens.colorPaletteYellowForeground1;
    case 'info':
      return tokens.colorBrandForeground1;
    case 'debug':
    default:
      return tokens.colorNeutralForeground3;
  }
};

const formatTimestamp = (at: string): string => {
  const d = new Date(at);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
};

const formatDuration = (startedAt: string, endedAt?: string): string => {
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}:${(minutes % 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
};

export interface ActivityPanelProps {
  /** 表示するイベント */
  readonly events: readonly ActivityEvent[];
  /** 実行中・最近のジョブ */
  readonly jobs: readonly ActivityJobSummary[];
  /** 現在のフィルタ */
  readonly filter: ActivityFilter;
  /** フィルタ変更 */
  readonly onFilterChange: (filter: ActivityFilter) => void;
  /** パネルの展開/折りたたみ状態 */
  readonly collapsed?: boolean;
  /** 展開/折りたたみ状態変更 */
  readonly onCollapsedChange?: (collapsed: boolean) => void;
  /** ジョブクリック時のハンドラ */
  readonly onJobClick?: (jobId: string) => void;
  /** ログ行クリック時のハンドラ */
  readonly onEventClick?: (event: ActivityEvent) => void;
}

export const ActivityPanel: React.FC<ActivityPanelProps> = ({
  events,
  jobs,
  filter,
  onFilterChange,
  collapsed = false,
  onCollapsedChange,
  onJobClick,
  onEventClick,
}) => {
  const styles = useStyles();
  const [selectedTab, setSelectedTab] = useState<ActivityTab>('log');
  const [autoScroll, setAutoScroll] = useState(true);
  const contentRef = React.useRef<HTMLDivElement>(null);

  // 自動スクロール (最新のログ行を表示)
  useEffect(() => {
    if (autoScroll && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // フィルタ済みイベント
  const filteredEvents = useMemo(() => {
    return events.filter((event) => {
      // レベルフィルタ
      const levelPriority = { debug: 0, info: 1, warn: 2, error: 3 };
      if (levelPriority[event.level] < levelPriority[filter.level]) {
        return false;
      }

      // カテゴリフィルタ (タブによる)
      if (selectedTab === 'sent' && event.category !== 'request') return false;
      if (selectedTab === 'rejected' && event.category !== 'egress-denied') return false;
      if (selectedTab === 'error' && event.category !== 'error') return false;

      // ソースフィルタ
      if (filter.source && event.source !== filter.source) return false;

      // テキスト検索
      if (filter.search && !event.message.toLowerCase().includes(filter.search.toLowerCase())) {
        return false;
      }

      // ジョブフィルタ
      if (filter.jobId && event.jobId !== filter.jobId) return false;
      if (filter.runId && event.runId !== filter.runId) return false;

      return true;
    });
  }, [events, filter, selectedTab]);

  // タブごとのカウント
  const counts = useMemo(() => {
    return {
      jobs: jobs.filter((j) => j.state === 'running').length,
      log: events.length,
      sent: events.filter((e) => e.category === 'request').length,
      rejected: events.filter((e) => e.category === 'egress-denied').length,
      error: events.filter((e) => e.category === 'error').length,
    };
  }, [events, jobs]);

  const handleTabSelect = useCallback((_: SelectTabEvent, data: SelectTabData) => {
    if (typeof data.value === 'string') setSelectedTab(data.value as ActivityTab);
  }, []);

  const renderJobs = () => {
    if (jobs.length === 0) {
      return <div className={styles.empty}>実行中のジョブはありません</div>;
    }

    return jobs.map((job) => (
      <div
        key={job.jobId}
        className={styles.jobRow}
        onClick={() => onJobClick?.(job.jobId)}
      >
        <div className={styles.jobLeft}>
          <Text weight="semibold">{job.label}</Text>
          <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
            {job.state === 'running' ? `実行中 ${formatDuration(job.startedAt)}` : job.state}
            {' • '}
            送信 {job.counters.requestsSent}
            {job.counters.deniedByScope > 0 && ` • 拒否 ${job.counters.deniedByScope}`}
            {job.counters.errors > 0 && ` • エラー ${job.counters.errors}`}
          </Text>
        </div>
        <div className={styles.jobRight}>
          {job.state === 'running' && (
            <Badge appearance="filled" color="brand">
              実行中
            </Badge>
          )}
          {job.state === 'stopped' && (
            <Badge appearance="outline" color="warning">
              停止
            </Badge>
          )}
          {job.state === 'completed' && (
            <Badge appearance="outline" color="success">
              完了
            </Badge>
          )}
          {job.state === 'failed' && (
            <Badge appearance="filled" color="danger">
              失敗
            </Badge>
          )}
        </div>
      </div>
    ));
  };

  const renderLog = () => {
    if (filteredEvents.length === 0) {
      return <div className={styles.empty}>イベントはありません</div>;
    }

    return filteredEvents.map((event) => (
      <div
        key={event.seq}
        className={styles.logLine}
        onClick={() => onEventClick?.(event)}
      >
        <span className={styles.timestamp}>{formatTimestamp(event.at)}</span>
        <span className={styles.level} style={{ color: getLevelColor(event.level) }}>
          {event.level.toUpperCase()}
        </span>
        <span className={styles.source}>{event.source}</span>
        <span className={styles.message}>{event.message}</span>
      </div>
    ));
  };

  if (collapsed) {
    return (
      <div className={styles.root} style={{ minHeight: 'auto' }}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <Text className={styles.title}>アクティビティ</Text>
            {counts.jobs > 0 && <Badge color="brand">{counts.jobs} 実行中</Badge>}
            {counts.rejected > 0 && <Badge color="warning">{counts.rejected} 拒否</Badge>}
            {counts.error > 0 && <Badge color="danger">{counts.error} エラー</Badge>}
          </div>
          <Button
            appearance="subtle"
            icon={<ChevronUp20Regular />}
            onClick={() => onCollapsedChange?.(false)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Text className={styles.title}>アクティビティ</Text>
          <TabList selectedValue={selectedTab} onTabSelect={handleTabSelect}>
            <Tab value="jobs">
              ジョブ {counts.jobs > 0 && <Badge>{counts.jobs}</Badge>}
            </Tab>
            <Tab value="log">ログ</Tab>
            <Tab value="sent">
              送信 {counts.sent > 0 && <Badge>{counts.sent}</Badge>}
            </Tab>
            <Tab value="rejected">
              拒否 {counts.rejected > 0 && <Badge color="warning">{counts.rejected}</Badge>}
            </Tab>
            <Tab value="error">
              エラー {counts.error > 0 && <Badge color="danger">{counts.error}</Badge>}
            </Tab>
          </TabList>
        </div>
        <Button
          appearance="subtle"
          icon={<ChevronDown20Regular />}
          onClick={() => onCollapsedChange?.(true)}
        />
      </div>

      {selectedTab !== 'jobs' && (
        <div className={styles.toolbar}>
          <Input
            className={styles.searchBox}
            placeholder="検索..."
            contentBefore={<Search20Regular />}
            contentAfter={
              filter.search ? (
                <Button
                  appearance="subtle"
                  icon={<Dismiss20Regular />}
                  size="small"
                  onClick={() => { const { search: _ignored, ...rest } = filter; onFilterChange(rest); }}
                />
              ) : null
            }
            value={filter.search || ''}
            onChange={(_, data) => { const { search: _ignored, ...rest } = filter; onFilterChange(data.value ? { ...rest, search: data.value } : rest); }}
          />
          <Dropdown
            placeholder="水準"
            value={filter.level}
            selectedOptions={[filter.level]}
            onOptionSelect={(_, data) =>
              onFilterChange({ ...filter, level: data.optionValue as 'debug' | 'info' | 'warn' | 'error' })
            }
          >
            <Option value="debug">DEBUG</Option>
            <Option value="info">INFO</Option>
            <Option value="warn">WARN</Option>
            <Option value="error">ERROR</Option>
          </Dropdown>
          <Dropdown
            placeholder="出典"
            value={filter.source || '全て'}
            selectedOptions={filter.source ? [filter.source] : []}
            onOptionSelect={(_, data) =>
              onFilterChange({ ...filter, source: data.optionValue === '全て' ? undefined : data.optionValue as any })
            }
          >
            <Option value="全て">全て</Option>
            <Option value="scopepilot">ScopePilot</Option>
            <Option value="zap">ZAP</Option>
            <Option value="nuclei">Nuclei</Option>
            <Option value="playwright">Playwright</Option>
            <Option value="system">System</Option>
          </Dropdown>
          <Switch
            label="自動スクロール"
            checked={autoScroll}
            onChange={(_, data) => setAutoScroll(data.checked)}
          />
        </div>
      )}

      <div ref={contentRef} className={styles.content}>
        {selectedTab === 'jobs' ? renderJobs() : renderLog()}
      </div>
    </div>
  );
};
