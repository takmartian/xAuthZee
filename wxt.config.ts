import { defineConfig } from 'wxt';

// Chrome / Edge / Firefox 共用同一份配置，代码零分叉。
// 三者的差异只体现在打包产物与上架材料上：
//   npm run zip        -> .output/xauthzee-<v>-chrome.zip
//   npm run zip:edge   -> .output/xauthzee-<v>-edge.zip
//   npm run zip:firefox -> .output/xauthzee-<v>-firefox.zip
//
// **Firefox 降级**：Firefox WebExtensions 不支持 `chrome.idle` API。
// background.ts:143 用 `chromeGlobal?.idle?.onStateChanged?.addListener`
// 防御式调用 —— 没有 idle 时自然走 noop。这意味着在 Firefox 上，
// 系统锁屏不会立即触发自动锁（5/15/30/60 分钟定时器照常工作）。
//
// **Firefox MV3**：WXT 默认 firefox target build MV2；manifestVersion: 3
// 全局切到 MV3（与 Chrome / Edge 一致）。AMO 审核要求
// browser_specific_settings.gecko.id —— WXT 会自动注入，但首次上架
// 需要在 AMO 后台申请正式 ID 后覆盖这里。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  // 关闭自动导入：显式 import 对 TS 跳转和后期重构更友好。
  imports: false,

  // 全局 MV3 —— Chrome / Edge 默认就是 MV3，Firefox 也强制 MV3。
  // Firefox MV3 在 109+ 支持。
  manifestVersion: 3,

  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',

    // 权限保持最小集，三家商店都会逐项追问用途：
    //   storage   账号数据（browser.storage.sync）
    //   activeTab 二维码框选时截取当前标签页 + 读取当前站点域名
    //   scripting 按需注入框选遮罩脚本
    //   alarms    主密码空闲自动上锁的定时检查
    //   idle      系统锁屏时立即上锁（**Firefox 无此 API，自动 noop**）
    permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'idle'],

    action: {
      default_title: '__MSG_extName__',
    },

    // Firefox AMO 上架要求：在 AMO 后台申请正式 ID 后回填
    // （例如 `@xauthzee`）。首次开发期用占位 ID。
    browser_specific_settings: {
      gecko: {
        id: 'xauthzee@wxt.dev',
        strict_min_version: '109.0',
      },
    },

    // otpfill.css 由 WXT 自动加进 web_accessible_resources（来自
    // cssInjectionMode: 'ui'）。qrselect.css 通过 Vite ?inline 直接
    // 打成字符串进 JS bundle，不需要 web_accessible。
  },
});
