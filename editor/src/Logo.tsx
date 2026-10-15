/** The app icon (art/icon.svg), cropped like a launcher shows it, for the header. */
export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="18 18 72 72" aria-hidden="true">
      <defs>
        <linearGradient id="logo-bg" x1="0" y1="0" x2="108" y2="108" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5B2EFF" />
          <stop offset="1" stopColor="#FF3D7F" />
        </linearGradient>
        <linearGradient id="logo-ink" x1="42" y1="44" x2="66" y2="66" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5B2EFF" />
          <stop offset="1" stopColor="#F0367C" />
        </linearGradient>
        <linearGradient id="logo-flap" x1="78" y1="72" x2="63" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="0.55" stopColor="#E9E2FF" />
          <stop offset="1" stopColor="#B9A5FF" />
        </linearGradient>
      </defs>
      <rect x="18" y="18" width="72" height="72" fill="url(#logo-bg)" />
      <g transform="translate(54 54) scale(0.8) rotate(-8) translate(-54 -54)">
        <path
          d="M42 30H66A12 12 0 0 1 78 42V58L64 72H52L38 82L41 72A11 11 0 0 1 30 61V42A12 12 0 0 1 42 30Z"
          fill="#FFFFFF"
        />
        <path
          d="M42.4 46A3.6 3.6 0 1 0 49.6 46A3.6 3.6 0 1 0 42.4 46Z M58.4 46A3.6 3.6 0 1 0 65.6 46A3.6 3.6 0 1 0 58.4 46Z M41.6 55.9Q54 69.5 66.4 55.9A2.5 2.5 0 0 0 61.6 54.1Q54 62.5 46.4 54.1A2.5 2.5 0 0 0 41.6 55.9Z"
          fill="url(#logo-ink)"
        />
        <path d="M78 58L64 72L65 59Z" fill="#2A0D55" fillOpacity="0.22" />
        <path d="M78 58C72 57 65 56 64.5 58.5C63 61 63.5 67 64 72Z" fill="url(#logo-flap)" />
      </g>
    </svg>
  );
}
