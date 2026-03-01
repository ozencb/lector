import { SunIcon, MoonIcon } from '@radix-ui/react-icons';
import { useTheme } from '../hooks/useTheme.js';
import styles from './ThemeToggle.module.scss';

export default function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();

  return (
    <button
      className={`${styles.button} ${className ?? ''}`}
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? <SunIcon width={18} height={18} /> : <MoonIcon width={18} height={18} />}
    </button>
  );
}
