/** Le bouclier d'Oathrion, le même que dans la notification et sur la carte partagée. */
export function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 27" className={className} role="img" aria-label="Oathrion" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="oathrion-shield" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#DF64FF" />
          <stop offset="1" stopColor="#5B3BFF" />
        </linearGradient>
      </defs>
      <path fill="url(#oathrion-shield)" d="M12 1 2.5 5v7c0 6.2 4.1 11.9 9.5 13.5 5.4-1.6 9.5-7.3 9.5-13.5V5L12 1z" />
      <path fill="#FFFFFF" d="M12 7.5l1.4 4 4 1.4-4 1.4-1.4 4-1.4-4-4-1.4 4-1.4z" />
    </svg>
  );
}

export function LogoLockup() {
  return (
    <div className="flex items-center gap-2.5">
      <Logo className="h-7 w-7 drop-shadow-[0_0_10px_rgba(150,62,255,0.45)]" />
      <span className="text-[15px] font-semibold tracking-tight">Oathrion</span>
    </div>
  );
}
