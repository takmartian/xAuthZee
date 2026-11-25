import { defineConfig } from 'wxt';

// **只支持 Chrome**（以及同内核的浏览器加载 Chrome 包）。
// 曾经同时出 Edge / Firefox 三个目标，实测维护成本大于收益：多两个
// 商店的上架材料、多一套 Firefox 的 API 差异说明，而实际用户全在 Chrome。
// 现在构建产物只有一个：
//   npm run zip -> .output/xauthzee-<v>-chrome.zip
//
// manifestVersion 显式写 3：Chrome 默认就是 MV3，写出来是为了让「不要
// 再产出 MV2 包」这件事在配置里看得见。
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  // 关闭自动导入：显式 import 对 TS 跳转和后期重构更友好。
  imports: false,

  manifestVersion: 3,

  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',

    // 权限保持最小集，商店会逐项追问用途：
    //   storage   账号数据（chrome.storage.sync）
    //   activeTab 二维码框选时截取当前标签页 + 读取当前站点域名
    //   scripting 按需注入框选遮罩脚本
    //   alarms    主密码空闲自动上锁的定时检查
    //   idle      系统锁屏时立即上锁
    permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'idle'],

    action: {
      default_title: '__MSG_extName__',
    },

    // otpfill.css 由 WXT 自动加进 web_accessible_resources（来自
    // cssInjectionMode: 'ui'）。qrselect.css 通过 Vite ?inline 直接
    // 打成字符串进 JS bundle，不需要 web_accessible。
  },
});
