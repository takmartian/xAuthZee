# Store Assets — 上架材料清单

Chrome Web Store 和 Edge Add-ons 共用大部分材料，但提交步骤有差别。
所有材料都在 `store-assets/` 下，重新生成命令：

```bash
npm run store-assets      # 重新生成 promo + screenshots
npm run build              # 编译扩展
npm run zip                # 打包 Chrome zip
npm run zip:edge           # 打包 Edge zip
```

## 文件清单

| 文件 / 目录                     | 用途                                  |
| ------------------------------- | ------------------------------------- |
| `privacy.md`                    | 隐私声明（两家商店都要求引用 URL）     |
| `listing/description-en.md`     | 英文 store listing（长 + 短描述）      |
| `listing/description-zh.md`     | 中文 store listing                     |
| `promo/small-440x280.png`       | 小型 promo tile（Chrome 必填）         |
| `promo/large-920x680.png`       | 大型 promo tile（Chrome 必填）         |
| `promo/marquee-1400x560.png`    | 横幅 promo tile（Chrome 必填）         |
| `screenshots/01-popup.png`      | 主 popup 截屏                          |
| `screenshots/02-otp-overlay.png` | OTP 浮层触发截屏                        |
| `screenshots/03-options.png`    | 设置页截屏                             |
| `screenshots/04-locked.png`     | 锁定态截屏                              |
| `.output/xauthzee-<v>-chrome.zip` | Chrome 商店上传包                       |
| `.output/xauthzee-<v>-edge.zip`  | Edge 商店上传包                         |

## Chrome Web Store 提交清单

去 https://chrome.google.com/webstore/devconsole/ 新建 item。

1. **Package** → 上传 `xauthzee-<v>-chrome.zip`
2. **Store listing**：
   - Name: `XAuthZee` （从 `__MSG_extName__` 自动按用户语言切）
   - Summary: ≤ 132 字符 —— 用 `listing/description-en.md` 顶部的"短描述"
   - Description: 用 `listing/description-en.md` 的"长描述"全文
   - Category: `Productivity`
   - Language: English (default) + Simplified Chinese
3. **Graphic assets**：
   - Icon: 已有 16/32/48/128 PNG（`public/icon/`，WXT 自动塞 manifest）
   - Small promo tile: `promo/small-440x280.png` ✓
   - Large promo tile: `promo/large-920x680.png` ✓
   - Marquee promo tile: `promo/marquee-1400x560.png` ✓
   - Screenshots: 至少 1 张，最多 5 张 —— `screenshots/*.png` 4 张
4. **Privacy practices**（必填）：
   - Single purpose: "TOTP authenticator for managing one-time password codes"
   - Permission `storage`: "Stores accounts locally and syncs via browser"
   - Permission `activeTab`: "Reads current tab URL on user click to bind host or capture QR"
   - Permission `scripting`: "Injects QR region-selector content script on user action"
   - Permission `alarms`: "Schedules master-password auto-lock timer"
   - Permission `idle`: "Detects system lock to immediately lock the extension"
   - Data usage: 全部 "No, this extension does not collect, use, or transfer any of these"
   - Host permission: 不需要（用 activeTab 代替）
   - Remote code: No
5. **Privacy policy**：
   - 填 `privacy.md` 全文（把 md 渲染到能公网访问的 URL 填入；或建一个 GitHub Pages）
   - 文本：见 `privacy.md`
6. **Distribution**：
   - Visibility: Public
   - Regions: All
7. Submit for review —— 首次通常 1-3 天

## Edge Add-ons 提交清单

去 https://partner.microsoft.com/dashboard/microsoftedge/Extension/new

1. **Package** → 上传 `xauthzee-<v>-edge.zip`
2. **Extension overview**：
   - Name: `XAuthZee`
   - Short description: ≤ 200 字符
   - Long description: 复用 `listing/description-en.md` 的"长描述"或中文版
3. **Listing details**：
   - Category: `Productivity`
   - Privacy policy URL: 同上
4. **Store listing assets**：
   - Logo: 已有 16/32/48/128 PNG
   - Screenshots: 上传 `screenshots/*.png`（Edge 不强制要 promo tile，但建议加）
5. **Properties**：
   - Languages: English + Simplified Chinese
   - Website / Support URL: GitHub repo（如果开了）
6. **Privacy** → "Does this extension collect or transmit any data?" → **No**
7. Submit → 通常 1-7 天

## 注意事项

1. **Icon 复用**：4 个尺寸的 PNG（16/32/48/128）放在 `public/icon/`，WXT 自动塞进 manifest
2. **版本号同步**：`package.json` 改 version 后跑 `npm run zip` 才会出新 zip
3. **大小写敏感**：商店表单里 Name / Description 拼写与 `_locales` 一致，否则 manifest 校验报错
4. **隐私 URL 必须可公网访问**：最方便是 GitHub Pages，把 `privacy.md` 放仓库根 + 开 Pages
5. **screenshots 是占位**：手画的简易版，上架前建议用 Playwright 截真实 UI 替换
6. **promo tiles 也是占位**：5x7 ASCII 字体 + 纯色块，无设计师审美。上架前建议用 Figma 替换

## 商店审核常见拒因（提前规避）

- [x] 权限最小化：5 个权限都解释了用途，没多余
- [x] 不收集数据：隐私声明 + Chrome data usage 全部勾 No
- [x] 不打包远程代码：WXT build 产物全本地
- [x] Single purpose 清晰
- [ ] 商店要求多语言 → 至少 EN 必填，ZH 是加分项
- [ ] 真实 screenshots：手画的占位版审核员可能要求替换
- [ ] 隐私 URL 可公网访问
