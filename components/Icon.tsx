/**
 * 统一的小图标。strokeWidth 固定 1.4，linecap/linejoin 固定 round，
 * 这样所有图标视觉重量一致，凑在一起也不打架。
 *
 * 当前这套是手画的 16×16 SVG，没引入 lucide / heroicons 之类 —— 那
 * 些库会让 popup bundle 多几十 KB，且我们只需要十几个图标。
 */

interface IconProps {
  size?: number;
  className?: string;
  'aria-hidden'?: boolean;
}

function svgProps(p: IconProps) {
  return {
    width: p.size ?? 16,
    height: p.size ?? 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': (p['aria-hidden'] ?? true) as boolean,
    className: p.className,
    style: { display: 'block' },
  };
}

export function TrashIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 9h5L11 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function ChevronUpIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M4 10l4-4 4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronDownIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <path d="M3.5 8.5l3 3 6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function QrIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <rect x="2.5" y="2.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9.5" y="2.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <rect x="2.5" y="9.5" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 9.5h1.5v1.5M9.5 13h.01M13 9.5v.01M13 11.5v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function KeyboardIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <rect x="2" y="4" width="12" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5 7h.01M7 7h.01M9 7h.01M11 7h.01M5 9.5h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function MoreIcon(p: IconProps) {
  return (
    <svg {...svgProps(p)}>
      <circle cx="3.5" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1" fill="currentColor" />
    </svg>
  );
}