import { describe, test, expect } from 'vitest';
import { pageItems } from '../../components/Pagination';

// pageItems decides which page buttons a pager draws. It is pure, and it is
// the only part of the pager with real logic, so it is worth pinning down:
// an off-by-one here shows the wrong pages or hides the last one, and the
// call log it was built for runs to hundreds of pages.

describe('pageItems', () => {
  test('lists every page when there are few enough to show them all', () => {
    expect(pageItems(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test('always includes the first and last page', () => {
    for (const current of [1, 5, 20, 50]) {
      const items = pageItems(current, 50);
      expect(items[0]).toBe(1);
      expect(items[items.length - 1]).toBe(50);
    }
  });

  test('shows the current page with one either side', () => {
    expect(pageItems(10, 50)).toContain(9);
    expect(pageItems(10, 50)).toContain(10);
    expect(pageItems(10, 50)).toContain(11);
  });

  test('collapses long runs into a gap marker, never a fake page number', () => {
    const items = pageItems(25, 50);
    expect(items).toContain('gap');
    // Every non-gap entry must be a real, in-range page — rendering a number
    // outside the range would produce a button leading nowhere.
    for (const it of items) {
      if (it === 'gap') continue;
      expect(Number.isInteger(it)).toBe(true);
      expect(it).toBeGreaterThanOrEqual(1);
      expect(it).toBeLessThanOrEqual(50);
    }
  });

  test('renders a one-page gap as that page rather than an ellipsis', () => {
    // Current page 4 of 50 leaves exactly page 2 between 1 and 3. An ellipsis
    // there would take the same width while hiding a page you could click.
    expect(pageItems(4, 50)).toEqual([1, 2, 3, 4, 5, 'gap', 50]);
  });

  test('never repeats a page', () => {
    for (const current of [1, 2, 3, 25, 48, 49, 50]) {
      const items = pageItems(current, 50).filter(i => i !== 'gap');
      expect(new Set(items).size).toBe(items.length);
    }
  });

  test('stays ascending, so the buttons read left to right', () => {
    const nums = pageItems(25, 50).filter(i => i !== 'gap');
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  test('handles the degenerate single-page case', () => {
    expect(pageItems(1, 1)).toEqual([1]);
  });
});
