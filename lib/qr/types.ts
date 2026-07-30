/**
 * 二维码链路的几何类型。
 *
 * 把所有像素坐标都统一成「设备像素」（实际光栅化的像素），
 * 这样 jsQR、CaptureVisibleTab、Canvas ImageData 三者之间的换算
 * 都是同一种单位，避免在调用边界再写一层 devicePixelRatio 变换。
 */

/** 矩形，坐标是设备像素 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 用户在页面上看到的矩形，坐标是 CSS 像素 */
export interface ViewportRect {
  x: number;
  y: number;
  w: number;
  h: number;
}