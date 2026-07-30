import { memo } from 'react';

/**
 * 倒计时环。
 *
 * 一个 SVG 圆环，从满到空地消耗表示当前 TOTP 周期的剩余时间。
 * 视觉上比纯数字「还剩 12 秒」更直观 —— 一眼就能看出还差多少。
 *
 * 用 stroke-dasharray + stroke-dashoffset 实现：
 *   dasharray = 周长
 *   dashoffset = 周长 × (1 - progress)
 *
 * progress 接近 1 时 dashoffset 也接近周长，圆环看上去几乎消失。
 * 这样观感是「从满到空消耗」，符合直觉。
 *
 * progress 的语义见 lib/totp.ts：0 是周期刚开始，1 刚要进入下一周期。
 */

interface RingProps {
  /** 0..1，已过去的比例 */
  progress: number;
  /** 直径，px */
  size?: number;
  /** 环线宽，px */
  strokeWidth?: number;
  /** 圆环颜色，传 CSS 颜色字符串 */
  color?: string;
  /** 轨道（未填充部分）颜色 */
  trackColor?: string;
  /** ARIA 标签：无障碍读屏需要 */
  label?: string;
}

function RingInner({
  progress,
  size = 20,
  strokeWidth = 2.5,
  color = 'currentColor',
  trackColor = 'var(--xz-border)',
  label,
}: RingProps) {
  // 取整到 0.1% 精度，避免极小数抖动带来的视觉杂讯
  const p = Math.max(0, Math.min(1, progress));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - p);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      style={{ display: 'block', flexShrink: 0 }}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={trackColor}
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        // 从顶部开始顺时针绘制
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export const Ring = memo(RingInner);