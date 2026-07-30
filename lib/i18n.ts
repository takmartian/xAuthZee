import { browser } from 'wxt/browser';

/**
 * 文案 key 的类型直接从 WXT 依据 _locales 生成的重载签名里取。
 * 好处是拼错 key 会在编译期报错，而不是运行时静默显示空白，
 * 而且新增文案后无需手工维护这份联合类型。
 */
export type MessageKey = Parameters<typeof browser.i18n.getMessage>[0];

/**
 * chrome.i18n.getMessage 的薄封装。
 *
 * 除了类型收窄，还兜住一种情况：key 在 _locales 里存在但当前语言漏翻时，
 * getMessage 会返回空字符串。此时退回显示 key 本身，界面上一眼能看出问题，
 * 比显示一片空白好排查。
 */
export function t(key: MessageKey, substitutions?: string | string[]): string {
  const message = browser.i18n.getMessage(key, substitutions);
  if (!message) {
    if (import.meta.env.DEV) {
      console.warn(`[XAuthZee] untranslated i18n key: ${key}`);
    }
    return key;
  }
  return message;
}
