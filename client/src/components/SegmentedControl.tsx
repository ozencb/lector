import styles from './SegmentedControl.module.scss';

interface SegmentedControlProps {
  items: { label: string; value: string }[];
  value: string;
  onChange: (value: string) => void;
}

export default function SegmentedControl({ items, value, onChange }: SegmentedControlProps) {
  return (
    <div className={styles.group}>
      {items.map((item) => (
        <button
          key={item.value}
          className={`${styles.button} ${item.value === value ? styles.active : ''}`}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
