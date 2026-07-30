import { defineConfig } from 'wxt';

// Chrome 与 Edge 共用同一份配置，代码零分叉。
// 两者的差异只体现在打包产物与上架材料上：
//   npm run zip       -> .output/xauthzee-<v>-chrome.zip
//   npm run zip:edge  -> .output/xauthzee-<v>-edge.zip
export default defineConfig({
  modules: ['@wxt-dev/module-react'],

  // 关闭自动导入：显式 import 对 TS 跳转和后期重构更友好。
  imports: false,

  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',

    // 权限保持最小集，两家商店都会逐项追问用途：
    //   storage   账号数据（chrome.storage.sync）
    //   activeTab 二维码框选时截取当前标签页 + 读取当前站点域名
    //   scripting 按需注入框选遮罩脚本
    //   alarms    主密码空闲自动上锁的定时检查
    //   idle      系统锁屏时立即上锁
    permissions: ['storage', 'activeTab', 'scripting', 'alarms', 'idle'],

    action: {
      default_title: '__MSG_extName__',
    },
  },
});
