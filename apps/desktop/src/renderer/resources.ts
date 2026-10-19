/**
 * 文字列資源の引き出し (design/28 §8.1 MUST 10)。locale 別 table から選び、
 * {name} placeholder を params で置換する (文の連結はしない)。
 * 未設定 locale は ja。en に無い key は無い (StringKey で完全性を型強制)。
 */
import { enStrings } from './resources.en.ts';
import { jaStrings, type StringKey } from './resources.ja.ts';

export type Locale = 'ja' | 'en';
export type { StringKey };

export const localeTables: Readonly<Record<Locale, Readonly<Record<StringKey, string>>>> = {
  ja: jaStrings,
  en: enStrings,
};

let currentLocale: Locale = 'ja';

export function setLocale(locale: Locale): void {
  currentLocale = locale;
}

export function getLocale(): Locale {
  return currentLocale;
}

export function t(key: StringKey, params: Readonly<Record<string, string | number>> = {}): string {
  let text: string = localeTables[currentLocale][key];
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}
