// A viewport-height length for anything rendered INSIDE .app-shell.
//
// On wide screens index.css zooms .app-shell (1.15 / 1.3), and zoom scales
// vh too: a 92vh popup rendered at 106% of the window, cutting off its header
// and Save button. Dividing by the shell's --app-zoom (set alongside the zoom
// in index.css) makes `vh(92)` exactly 92% of the real window at every size.
// Not for portals to document.body (not zoomed, and --app-zoom is not set there,
// so the fallback of 1 keeps them correct anyway).
export const vh = n => `calc(${n}vh / var(--app-zoom, 1))`;
