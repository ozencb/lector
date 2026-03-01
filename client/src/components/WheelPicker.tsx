import { useEffect, useRef } from 'react';
import styles from './WheelPicker.module.scss';

interface WheelPickerItem {
  label: string;
  value: string;
}

interface WheelPickerProps {
  items: WheelPickerItem[];
  value: string;
  onChange: (value: string) => void;
}

const ITEM_HEIGHT = 44;
const VISIBLE_COUNT = 5;

export default function WheelPicker({ items, value, onChange }: WheelPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const isScrolling = useRef(false);
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const selectedIdx = items.findIndex(i => i.value === value);

  // Scroll to selected item on mount
  useEffect(() => {
    const el = listRef.current;
    if (!el || selectedIdx < 0) return;
    el.scrollTop = selectedIdx * ITEM_HEIGHT;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleScroll = () => {
    isScrolling.current = true;
    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      isScrolling.current = false;
      const el = listRef.current;
      if (!el) return;
      const idx = Math.round(el.scrollTop / ITEM_HEIGHT);
      const clamped = Math.max(0, Math.min(idx, items.length - 1));
      el.scrollTo({ top: clamped * ITEM_HEIGHT, behavior: 'smooth' });
      if (items[clamped] && items[clamped].value !== value) {
        onChange(items[clamped].value);
      }
    }, 80);
  };

  const handleClick = (idx: number) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: idx * ITEM_HEIGHT, behavior: 'smooth' });
    if (items[idx].value !== value) {
      onChange(items[idx].value);
    }
  };

  // Padding items so the first/last can be centered
  const padCount = Math.floor(VISIBLE_COUNT / 2);

  return (
    <div className={styles.wheel} style={{ height: ITEM_HEIGHT * VISIBLE_COUNT }}>
      <div className={styles.highlight} style={{ top: ITEM_HEIGHT * padCount, height: ITEM_HEIGHT }} />
      <div className={styles.fadeTop} style={{ height: ITEM_HEIGHT * padCount }} />
      <div className={styles.fadeBottom} style={{ height: ITEM_HEIGHT * padCount }} />
      <div
        ref={listRef}
        className={styles.list}
        onScroll={handleScroll}
        style={{ paddingTop: ITEM_HEIGHT * padCount, paddingBottom: ITEM_HEIGHT * padCount }}
      >
        {items.map((item, idx) => (
          <button
            key={item.value}
            className={`${styles.item} ${item.value === value ? styles.itemActive : ''}`}
            style={{ height: ITEM_HEIGHT }}
            onClick={() => handleClick(idx)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
