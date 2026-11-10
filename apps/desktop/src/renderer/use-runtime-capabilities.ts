import { useEffect, useState } from 'react';
import type { RuntimeAdapterCapability } from '@scopepilot2/contracts';

/** Controls stay disabled until the current Core configuration is known. */
export function useRuntimeCapabilities(apiBase: string) {
  const [state, setState] = useState<{ base: string; adapters: readonly RuntimeAdapterCapability[]; failed: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase}/api/capabilities`, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { adapters?: readonly RuntimeAdapterCapability[] };
        if (!controller.signal.aborted) setState({ base: apiBase, adapters: body.adapters ?? [], failed: false });
      } catch {
        if (!controller.signal.aborted) setState({ base: apiBase, adapters: [], failed: true });
      }
    })();
    return () => controller.abort();
  }, [apiBase]);
  const current = state?.base === apiBase ? state : null;
  const capability = (name: string) => current?.adapters.find((adapter) => adapter.capability === name);
  return {
    available: (name: string) => capability(name)?.available === true,
    notice: (name: string) => {
      if (current === null) return '機能の利用可否を確認しています。';
      if (current.failed) return '機能の利用可否を取得できませんでした。';
      const adapter = capability(name);
      if (adapter?.available !== true) return 'この機能は現在の構成では利用できません。設定画面で接続を確認してください。';
      return adapter.adapterKind === 'fixture' ? '試験用データを使用します。実通信の診断結果ではありません。' : '';
    },
  };
}
