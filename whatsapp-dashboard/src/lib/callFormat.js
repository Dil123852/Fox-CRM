// Shared display helpers for the call-log pages (Calls.jsx, CallbackTracker.jsx).
//
// These live here rather than in either page because BOTH pages filter by
// calendar day and render call durations, and localDay in particular encodes a
// real bug fix (see its comment). Duplicating it would mean the next timezone
// fix lands in one page and the other silently keeps the bug — which is the
// exact failure its comment was written about.
//
// Deliberately NOT in lib/format.js: that file is scoped to product/variant
// display formatting and its own header warns about a name collision, so
// mixing unrelated call-log helpers in would muddy a file whose whole purpose
// is being unambiguous.

import { businessDay } from './businessTime';

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}:${String(rem).padStart(2, '0')}`;
}

// Sri Lanka calendar date (YYYY-MM-DD) of a timestamp, or '' if unparseable.
// Deliberately not the UTC date part: occurred_at is a timestamptz, and
// slicing its UTC string put a 19:30 UTC call on the previous day for a +5:30
// business — so filtering "Sep 1" returned a row the export rendered as 02/09.
// And not the viewer's computer's day either: a laptop set to another time
// zone would file calls under a different day than everyone else sees.
export function localDay(ts) {
  if (!ts) return '';
  return businessDay(ts);
}
