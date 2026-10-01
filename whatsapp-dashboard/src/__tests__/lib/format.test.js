import { describe, test, expect } from 'vitest';
import { formatDimension, variantValue } from '../../lib/format';
import { formatDimension as pdfFormatDimension } from '../../lib/pdfShared';

// These lock in the behaviour of the helpers extracted from LeadsPage,
// OrderDetailModal and LeadProductsPanel, which each had their own identical
// copy. The last test is the important one: the PDF variant is a DIFFERENT
// function and must stay different.

describe('formatDimension (UI)', () => {
  test('formats a catalog dimension with a multiplication sign and unit', () => {
    expect(formatDimension('72x60')).toBe('72 × 60 in');
    expect(formatDimension('84x36')).toBe('84 × 36 in');
  });

  test('accepts the separator variants that appear in real data', () => {
    expect(formatDimension('72 x 60')).toBe('72 × 60 in');
    expect(formatDimension('72X60')).toBe('72 × 60 in');
    expect(formatDimension('72×60')).toBe('72 × 60 in');
    expect(formatDimension('  72x60  ')).toBe('72 × 60 in');
  });

  test('passes a non-dimension value through unchanged rather than blanking it', () => {
    // A nominal size name, or anything unexpected, must still render.
    expect(formatDimension('Queen')).toBe('Queen');
    expect(formatDimension('72x')).toBe('72x');
    expect(formatDimension('x60')).toBe('x60');
  });

  test('renders empty for a missing value instead of "undefined"', () => {
    expect(formatDimension(null)).toBe('');
    expect(formatDimension(undefined)).toBe('');
    expect(formatDimension('')).toBe('');
  });
});

describe('variantValue', () => {
  test('prefers dimension, the current catalog shape', () => {
    expect(variantValue({ dimension: '72x60', size: 'Queen' })).toBe('72x60');
  });

  test('falls back to height for the three retired products', () => {
    // Legacy shape {size, height, price} — height is spring thickness.
    expect(variantValue({ height: '10', size: 'Single' })).toBe('10');
  });

  test('falls back to size when neither is present', () => {
    expect(variantValue({ size: 'Queen' })).toBe('Queen');
  });

  test('returns empty string for a price-only pillow variant', () => {
    expect(variantValue({ price: 2500 })).toBe('');
  });
});

describe('the PDF formatter is deliberately a different function', () => {
  test('PDF uses an ASCII x and no unit, UI uses × and " in"', () => {
    // Swapping one for the other would silently change rendered invoice and
    // quotation output, so they must not be consolidated.
    expect(pdfFormatDimension('72x60')).toBe('72 x 60');
    expect(formatDimension('72x60')).toBe('72 × 60 in');
    expect(pdfFormatDimension('72x60')).not.toBe(formatDimension('72x60'));
  });
});
