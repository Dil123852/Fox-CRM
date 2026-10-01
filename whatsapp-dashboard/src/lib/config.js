const RAW = import.meta.env.VITE_BACKEND_URL;

// `??` alone was not enough. An explicitly EMPTY value means "same-origin"
// (served behind nginx, which proxies /api/* to the backend) and must stay
// empty. But an UNSET value is `undefined`, and that used to fall through to
// the localhost default and get BAKED INTO the production bundle at build
// time — so every visitor's browser called http://localhost:3000, i.e. their
// own machine, and the dashboard showed no data while the server was fine.
//
// So the localhost fallback now applies ONLY in a dev build. In production an
// unset value resolves to same-origin, which is the correct deployment shape
// and fails loudly (a 404 from nginx) rather than silently pointing at the
// visitor's own computer.
export const BACKEND_URL = RAW ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');

if (!import.meta.env.DEV && RAW && /localhost|127\.0\.0\.1/.test(RAW)) {
  // A production bundle built with a localhost API URL can never work for a
  // real visitor. Surface it instead of failing silently.
  console.error(
    '[config] This production build was compiled with VITE_BACKEND_URL=' + RAW +
    ' — every visitor will try to call their OWN machine. Rebuild the frontend with ' +
    'VITE_BACKEND_URL empty (same-origin via nginx) or set to the real API host.'
  );
}
