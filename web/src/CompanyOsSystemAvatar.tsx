export function CompanyOsSystemAvatar({ className = "" }: { className?: string }) {
  return <span className={`company-os-system-avatar ${className}`.trim()} role="img" aria-label="Company OS 系统">
    <svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#071513" />
      <rect x="3.5" y="3.5" width="57" height="57" rx="14.5" fill="none" stroke="#22d3a5" strokeWidth="2" />
      <path d="M32 8v11M32 45v11M8 32h11M45 32h11" stroke="#45f0c0" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="32" cy="8" r="3" fill="#8affda" />
      <circle cx="32" cy="56" r="3" fill="#8affda" />
      <circle cx="8" cy="32" r="3" fill="#8affda" />
      <circle cx="56" cy="32" r="3" fill="#8affda" />
      <path d="M32 17 45 24.5v15L32 47l-13-7.5v-15L32 17Z" fill="#0d2d28" stroke="#40e6b8" strokeWidth="2.5" />
      <path d="M27 27h10v10H27z" fill="#6fffd1" opacity=".95" />
      <path d="M29.5 29.5h5v5h-5z" fill="#08201c" />
      <path d="M21 15.5 15.5 21M43 15.5l5.5 5.5M21 48.5l-5.5-5.5M43 48.5l5.5-5.5" stroke="#198d73" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M14 12h9M41 52h9" stroke="#b4ffe9" strokeWidth="1.5" strokeLinecap="round" opacity=".7" />
    </svg>
  </span>;
}
