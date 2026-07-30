import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  // M0：仅确认 Service Worker 能正常注册。
  // 后续这里承载消息路由、截屏、锁状态与定时器。
  console.info('[XAuthZee] background ready');
});
