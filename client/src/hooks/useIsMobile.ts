import { useEffect, useState } from 'react';

export default function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    () => window.matchMedia(`(max-width: ${breakpoint}px)`).matches,
  );

  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);

  return isMobile;
}
