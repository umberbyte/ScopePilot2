/** Playwright init-script DOM source/sink observation (design/f16). */
import { ScopePolicy, type DomObservationPort } from '@scopepilot2/core';

const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_SETTLE_MS = 250;

export interface DomObservationRunnerInput {
  readonly targetUrl: string;
  readonly scope: Parameters<DomObservationPort['observe']>[0]['scope'];
  readonly instrumentationScript: string;
  readonly maxEvents: number;
  readonly settleMs: number;
}

export type DomObservationRunner = (input: DomObservationRunnerInput) => ReturnType<DomObservationPort['observe']>;

/**
 * Kept as a plain script so it is installed before page scripts in every frame. It records bounded
 * values only in memory; the adapter fingerprints correlated values before they leave Core.
 */
export const DOM_INSTRUMENTATION_SCRIPT = String.raw`(() => {
  const KEY = '__scopepilotDomObserverV1';
  if (globalThis[KEY]) return;
  const state = { ready: true, events: [] };
  Object.defineProperty(globalThis, KEY, { value: state, configurable: false, enumerable: false });
  const record = (api, value) => {
    if (state.events.length >= 1000 || typeof value !== 'string' || value.length === 0) return;
    state.events.push({ api, marker: value.slice(0, 4096) });
  };
  try {
    for (const [, value] of new URLSearchParams(location.search)) record('location.search', value);
    record('location.hash', location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
    record('document.referrer', document.referrer);
    record('document.cookie', document.cookie);
  } catch {}
  addEventListener('message', event => record('postMessage.data', typeof event.data === 'string' ? event.data : ''));
  const scanInputs = () => {
    for (const element of document.querySelectorAll('input, textarea, select')) {
      if (typeof element.value === 'string') record('source:input.value', element.value);
    }
  };
  addEventListener('DOMContentLoaded', scanInputs, { once: true });
  addEventListener('input', event => record('source:input.value', event.target && event.target.value), true);
  const wrapSetter = (prototype, property, api) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (!descriptor || typeof descriptor.set !== 'function' || typeof descriptor.get !== 'function') return;
    Object.defineProperty(prototype, property, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) { record(api, typeof value === 'string' ? value : ''); return descriptor.set.call(this, value); },
    });
  };
  wrapSetter(Element.prototype, 'innerHTML', 'innerHTML');
  wrapSetter(Element.prototype, 'outerHTML', 'sink:outerHTML');
  if (globalThis.HTMLIFrameElement) wrapSetter(HTMLIFrameElement.prototype, 'srcdoc', 'sink:srcdoc');
  const originalInsertAdjacentHTML = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function(position, text) {
    record('sink:insertAdjacentHTML', text);
    return originalInsertAdjacentHTML.call(this, position, text);
  };
  const originalSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const lower = String(name).toLowerCase();
    if (lower === 'srcdoc' || lower.startsWith('on') || ((lower === 'src' || lower === 'href') && /^\s*javascript:/i.test(String(value)))) {
      record('sink:setAttribute', String(value));
    }
    return originalSetAttribute.call(this, name, value);
  };
  const originalWrite = Document.prototype.write;
  Document.prototype.write = function(...parts) {
    record('document.write', parts.join(''));
    return originalWrite.apply(this, parts);
  };
  const originalEval = globalThis.eval;
  globalThis.eval = function(value) {
    record('eval', typeof value === 'string' ? value : '');
    return originalEval.call(this, value);
  };
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = function(handler, timeout, ...args) {
    if (typeof handler === 'string') record('setTimeout(string)', handler);
    return originalSetTimeout.call(this, handler, timeout, ...args);
  };
  for (const storageName of ['localStorage', 'sessionStorage']) {
    try {
      const storage = globalThis[storageName];
      const originalGetItem = storage.getItem.bind(storage);
      storage.getItem = key => {
        const value = originalGetItem(key);
        record('source:' + storageName + '.getItem', value || '');
        return value;
      };
    } catch {}
  }
})();`;

function localBrowserProtocol(protocol: string): boolean {
  return protocol === 'about:' || protocol === 'blob:' || protocol === 'data:';
}

function inScopeHttpUrl(scope: DomObservationRunnerInput['scope'], url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return (protocol === 'http:' || protocol === 'https:') && ScopePolicy.decide(scope, url).allowed;
  } catch {
    return false;
  }
}

function validEvents(value: unknown, maxEvents: number): readonly { api: string; marker: string }[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const events: { api: string; marker: string }[] = [];
  for (const entry of value) {
    if (events.length >= maxEvents || typeof entry !== 'object' || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.api === 'string' && typeof record.marker === 'string' && record.api.length <= 128 && record.marker.length <= 4096) {
      events.push({ api: record.api, marker: record.marker });
    }
  }
  return events;
}

export const runPlaywrightDomObservation: DomObservationRunner = async (input) => {
  const playwright = await import('playwright');
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.addInitScript({ content: input.instrumentationScript });
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      try {
        const parsed = new URL(requestUrl);
        if (localBrowserProtocol(parsed.protocol) || ScopePolicy.decide(input.scope, requestUrl).allowed) {
          await route.continue();
          return;
        }
      } catch {
        // Invalid/non-URL requests are not allowed to leave this observer.
      }
      await route.abort('blockedbyclient');
    });
    await page.routeWebSocket('**', async (route) => {
      await route.close({ code: 1008, reason: 'DOM observation blocks WebSocket egress' });
    });
    await page.goto(input.targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(input.settleMs);

    const observations: { api: string; marker: string }[] = [];
    let instrumentedFrames = 0;
    for (const frame of page.frames()) {
      const frameUrl = frame.url();
      if (frameUrl === '' || frameUrl === 'about:blank') {
        continue;
      }
      if (!inScopeHttpUrl(input.scope, frameUrl)) {
        continue;
      }
      const result = await frame.evaluate((key) => {
        const state = (globalThis as Record<string, unknown>)[key] as { ready?: unknown; events?: unknown } | undefined;
        return state === undefined ? null : { ready: state.ready === true, events: state.events };
      }, '__scopepilotDomObserverV1');
      if (result === null || result.ready !== true) {
        throw new Error(`DOM instrumentation unavailable in frame: ${frameUrl}`);
      }
      instrumentedFrames += 1;
      observations.push(...validEvents(result.events, input.maxEvents - observations.length));
      if (observations.length >= input.maxEvents) {
        break;
      }
    }
    if (instrumentedFrames === 0) {
      throw new Error('DOM instrumentation unavailable: no in-scope frame completed the self-test');
    }
    const seen = new Set<string>();
    return {
      observations: observations.filter((event) => {
        const key = `${event.api}\0${event.marker}`;
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      }),
      // Initial real path deliberately avoids exporting DOM text snapshots.
      nodes: [],
    };
  } finally {
    await context.close();
    await browser.close();
  }
};

export interface PlaywrightDomObserverOptions {
  readonly runner?: DomObservationRunner;
  readonly maxEvents?: number;
  readonly settleMs?: number;
}

export class PlaywrightDomObserver implements DomObservationPort {
  private readonly runner: DomObservationRunner;
  private readonly maxEvents: number;
  private readonly settleMs: number;

  constructor(options: PlaywrightDomObserverOptions = {}) {
    this.runner = options.runner ?? runPlaywrightDomObservation;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    if (!Number.isInteger(this.maxEvents) || this.maxEvents <= 0 || this.maxEvents > 1000) {
      throw new Error('DOM maxEvents must be an integer between 1 and 1000');
    }
    if (!Number.isInteger(this.settleMs) || this.settleMs < 0 || this.settleMs > 10_000) {
      throw new Error('DOM settleMs must be an integer between 0 and 10000');
    }
  }

  async observe(input: Parameters<DomObservationPort['observe']>[0]): ReturnType<DomObservationPort['observe']> {
    if (!ScopePolicy.decide(input.scope, input.targetUrl).allowed) {
      throw new Error('DOM observation target is out of scope');
    }
    return await this.runner({
      ...input,
      instrumentationScript: DOM_INSTRUMENTATION_SCRIPT,
      maxEvents: this.maxEvents,
      settleMs: this.settleMs,
    });
  }
}
