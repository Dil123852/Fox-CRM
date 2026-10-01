// Every date and time in the dashboard is shown in Sri Lanka time, whatever
// time zone the viewer's computer happens to be set to.
//
// Why: a sales agent's laptop set to a US time zone showed a follow-up due
// "Oct 2" as "Oct 1" while the admin's laptop showed Oct 2 — same account,
// same data. The business runs on one clock, so the dashboard should too,
// without anyone having to fix the settings on every staff laptop.
//
// Two parts:
//   1. installBusinessTimeZone() (called once in main.jsx) makes every
//      toLocaleString / toLocaleDateString / toLocaleTimeString and every
//      Intl.DateTimeFormat default to Asia/Colombo. That covers the ~150
//      places that format a date, without editing each one. An explicit
//      timeZone passed by a caller is still respected.
//   2. Code that works out a calendar day BY HAND (getDate(), getMonth(),
//      toDateString(), toISOString().slice(0, 10)) is not touched by part 1,
//      so those few places use businessDay() / businessDateParts() instead.
//
// Date-only values from Postgres arrive as 'YYYY-MM-DD' (the DATE parser
// override in the backend). new Date('YYYY-MM-DD') is UTC midnight, which is
// 05:30 the SAME day in Colombo, so formatting it with part 1 gives the right
// day on every computer. Do not append 'T00:00' to such a string: that makes
// it the viewer's local midnight, which is the previous day in Colombo on a
// computer east of Sri Lanka.

export const BUSINESS_TZ = 'Asia/Colombo';

let installed = false;

function withZone(options) {
  if (options && options.timeZone) return options;
  return { ...(options || {}), timeZone: BUSINESS_TZ };
}

export function installBusinessTimeZone() {
  if (installed) return;
  installed = true;

  const OrigDTF = Intl.DateTimeFormat;
  // Callable with or without `new`, like the original; returning an object
  // from the constructor makes `new` give back the real formatter.
  function DateTimeFormat(locales, options) {
    return new OrigDTF(locales, withZone(options));
  }
  DateTimeFormat.prototype = OrigDTF.prototype;
  DateTimeFormat.supportedLocalesOf = OrigDTF.supportedLocalesOf.bind(OrigDTF);
  Intl.DateTimeFormat = DateTimeFormat;

  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const orig = Date.prototype[name];
    Object.defineProperty(Date.prototype, name, {
      configurable: true,
      writable: true,
      value: function (locales, options) {
        return orig.call(this, locales, withZone(options));
      },
    });
  }
}

// { year, month (1-12), day, hour, minute } of an instant, in Sri Lanka time,
// or null if unparseable.
export function businessDateParts(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute };
}

// The Sri Lanka calendar day of an instant as 'YYYY-MM-DD', or '' if
// unparseable. Defaults to now.
export function businessDay(ts = Date.now()) {
  const p = businessDateParts(ts);
  if (!p) return '';
  const pad = n => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// 'YYYY-MM-DD' shifted by a whole number of days (calendar arithmetic, no
// time zone involved).
export function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
