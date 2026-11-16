import { MARK_COLORS, MARK_PATH, MARK_VIEWBOX } from "@shared/brand-mark";

/** L'anneau d'Oathrion, le même que dans la notification, sur la carte partagée et sur le site. */
export function Logo({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox={MARK_VIEWBOX} className={className} role="img" aria-label="Oathrion" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="oathrion-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={MARK_COLORS.from} />
          <stop offset="1" stopColor={MARK_COLORS.to} />
        </linearGradient>
      </defs>
      <path fill="url(#oathrion-mark)" fillRule="evenodd" d={MARK_PATH} />
    </svg>
  );
}

export function LogoLockup() {
  return (
    <div className="flex items-center gap-2.5">
      <Logo className="h-7 w-7" />
      <span className="text-[15px] font-semibold tracking-tight">Oathrion</span>
    </div>
  );
}
