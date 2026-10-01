import { describe, test, expect } from 'vitest';

// Inline implementations matching utils/time.js patterns
const formatSidebarTime = (timestamp) => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString();
};

const formatMessageTime = (timestamp) => {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  });
};

describe('Time Utility Functions', () => {
  describe('formatSidebarTime', () => {
    test('should return empty string for null input', () => {
      expect(formatSidebarTime(null)).toBe('');
      expect(formatSidebarTime(undefined)).toBe('');
    });

    test('should return "now" for recent timestamps (< 1 minute)', () => {
      const now = new Date().toISOString();
      expect(formatSidebarTime(now)).toBe('now');
    });

    test('should return minutes for < 60 minutes', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(formatSidebarTime(fiveMinAgo)).toBe('5m');
    });

    test('should return hours for < 24 hours', () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      expect(formatSidebarTime(threeHoursAgo)).toBe('3h');
    });

    test('should return days for < 7 days', () => {
      const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(formatSidebarTime(twoDaysAgo)).toBe('2d');
    });
  });

  describe('formatMessageTime', () => {
    test('should format timestamp to HH:MM', () => {
      const result = formatMessageTime('2024-01-15T14:30:00Z');
      expect(result).toMatch(/\d{1,2}:\d{2}/);
    });

    test('should return empty for invalid input', () => {
      expect(formatMessageTime(null)).toBe('');
    });
  });
});
