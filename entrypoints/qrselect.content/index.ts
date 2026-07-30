import { defineContentScript } from 'wxt/utils/define-content-script';

/**
 * 二维码框选遮罩。
 *
 * registration: 'runtime' —— 不写进 manifest 的静态 content_scripts，
 * 而是用户点「扫描二维码」时由 background 通过 scripting.executeScript
 * 按需注入。这样这段代码只在 activeTab 授权下、且只在用户主动发起时
 * 才会进入页面，安装时也不会因此多出权限警告。
 */
export default defineContentScript({
  registration: 'runtime',
  matches: [],

  main() {
    console.info('[XAuthZee] qrselect injected');
  },
});
