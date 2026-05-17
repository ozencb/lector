export const FONT_SIZE_OPTIONS = [
  { label: 'XS', value: 'xs', rem: '1rem' },
  { label: 'S', value: 's', rem: '1.125rem' },
  { label: 'M', value: 'm', rem: '1.375rem' },
  { label: 'L', value: 'l', rem: '1.625rem' },
  { label: 'XL', value: 'xl', rem: '2rem' },
  { label: '2XL', value: '2xl', rem: '2.5rem' },
];

export const DEFAULT_FONT_SIZE = 'm';
export const FONT_SIZE_STORAGE_KEY = 'reader-font-size';

export function getFontSizeRem(value: string): string {
  return FONT_SIZE_OPTIONS.find(o => o.value === value)?.rem ?? '1.375rem';
}
