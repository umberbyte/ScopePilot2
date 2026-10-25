export interface LoginPageControl {
  readonly tag: string;
  readonly type: string;
  readonly id: string;
  readonly name: string;
  readonly autocomplete: string;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly label: string;
  readonly text: string;
  readonly formIndex: number | null;
  readonly selectorCandidates: readonly string[];
}

export interface LoginPageForm {
  readonly index: number;
  readonly action: string;
  readonly method: string;
  readonly id: string;
  readonly name: string;
  readonly text: string;
}

export interface LoginPageSnapshot {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly title: string;
  readonly language: string;
  readonly visibleText: string;
  readonly forms: readonly LoginPageForm[];
  readonly controls: readonly LoginPageControl[];
}

function httpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}が正しいURLではありません。`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label}はHTTPまたはHTTPSで指定してください。`);
  }
  url.username = '';
  url.password = '';
  return url;
}

/**
 * Playwrightでログインページを読み取り、AIへ渡せる最小限のDOM情報を作る。
 * 入力値・hidden値・Cookie・HTML全体は採取せず、認証情報がAI入力へ混入しないようにする。
 */
export async function observeLoginPage(
  requestedUrl: string,
  allowedOrigins: readonly string[],
): Promise<LoginPageSnapshot> {
  const requested = httpUrl(requestedUrl, 'ログインURL');
  const allowed = new Set(allowedOrigins.map((origin) => httpUrl(origin, '許可Origin').origin));
  if (!allowed.has(requested.origin)) {
    throw new Error(`ログインURLのOrigin ${requested.origin} をS01の許可Originまたは表示・認証用Originへ登録してください。`);
  }

  const playwright = await import('playwright');
  const browser = await playwright.chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) {
        await route.continue();
        return;
      }
      let origin = '';
      try { origin = new URL(requestUrl).origin; } catch { /* malformed requests are blocked below */ }
      if (allowed.has(origin)) await route.continue();
      else await route.abort('blockedbyclient');
    });
    await page.goto(requested.toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('input, button', { state: 'attached', timeout: 5_000 }).catch(() => undefined);
    const finalUrl = httpUrl(page.url(), '遷移後URL');
    if (!allowed.has(finalUrl.origin)) {
      throw new Error(`ログインページが許可されていないOrigin ${finalUrl.origin} へリダイレクトしました。`);
    }

    const observed = await page.evaluate(() => {
      const clip = (value: string | null | undefined, max = 500): string =>
        (value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
      const quote = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"');
      const unique = (selector: string): boolean => {
        try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
      };
      const cssIdentifier = (value: string): string => {
        if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
        return value.replace(/[^a-zA-Z0-9_-]/gu, (character) => `\\${character}`);
      };
      const selectorCandidates = (element: HTMLInputElement | HTMLButtonElement): string[] => {
        const tag = element.tagName.toLocaleLowerCase();
        const candidates: string[] = [];
        if (element.id !== '') candidates.push(`#${cssIdentifier(element.id)}`);
        if (element.getAttribute('name')) candidates.push(`${tag}[name="${quote(element.getAttribute('name') ?? '')}"]`);
        if (element.getAttribute('autocomplete')) candidates.push(`${tag}[autocomplete="${quote(element.getAttribute('autocomplete') ?? '')}"]`);
        if (element.getAttribute('aria-label')) candidates.push(`${tag}[aria-label="${quote(element.getAttribute('aria-label') ?? '')}"]`);
        if (element instanceof HTMLInputElement && element.type) candidates.push(`${tag}[type="${quote(element.type)}"]`);
        const form = element.closest('form');
        if (form !== null) {
          const formSelector = form.id !== ''
            ? `#${cssIdentifier(form.id)}`
            : form.getAttribute('name')
              ? `form[name="${quote(form.getAttribute('name') ?? '')}"]`
              : `form:nth-of-type(${Array.from(document.forms).indexOf(form) + 1})`;
          if (element.getAttribute('name')) candidates.push(`${formSelector} ${tag}[name="${quote(element.getAttribute('name') ?? '')}"]`);
          candidates.push(`${formSelector} ${tag}:nth-of-type(${Array.from(form.querySelectorAll(tag)).indexOf(element) + 1})`);
        }
        return [...new Set(candidates)].filter(unique).slice(0, 8);
      };
      const labelFor = (element: HTMLElement): string => {
        if (element.id !== '') {
          const label = Array.from(document.querySelectorAll('label')).find((candidate) => candidate.htmlFor === element.id);
          if (label !== undefined) return clip(label.textContent, 200);
        }
        return clip(element.closest('label')?.textContent, 200);
      };
      const forms = Array.from(document.forms).slice(0, 20).map((form, index) => ({
        index,
        action: form.action,
        method: form.method.toUpperCase(),
        id: clip(form.id, 200),
        name: clip(form.getAttribute('name'), 200),
        text: clip(form.innerText, 1_000),
      }));
      const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
        .filter((element) => {
          if (element instanceof HTMLInputElement && element.type === 'hidden') return false;
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        })
        .slice(0, 100)
        .map((element) => {
          const form = element.closest('form');
          return {
            tag: element.tagName.toLocaleLowerCase(),
            type: element instanceof HTMLInputElement ? element.type.toLocaleLowerCase() : 'button',
            id: clip(element.id, 200),
            name: clip(element.getAttribute('name'), 200),
            autocomplete: clip(element.getAttribute('autocomplete'), 100),
            placeholder: clip(element.getAttribute('placeholder'), 200),
            ariaLabel: clip(element.getAttribute('aria-label'), 200),
            label: labelFor(element),
            text: clip(
              element instanceof HTMLInputElement
                ? (['submit', 'button', 'image'].includes(element.type) ? element.getAttribute('value') : '')
                : element.textContent,
              200,
            ),
            formIndex: form === null ? null : Array.from(document.forms).indexOf(form),
            selectorCandidates: selectorCandidates(element),
          };
        });
      return {
        title: clip(document.title, 500),
        language: clip(document.documentElement.lang, 50),
        visibleText: clip(document.body?.innerText, 4_000),
        forms,
        controls,
      };
    });

    return {
      requestedUrl: requested.toString(),
      finalUrl: finalUrl.toString(),
      ...observed,
    };
  } finally {
    await context.close();
    await browser.close();
  }
}
