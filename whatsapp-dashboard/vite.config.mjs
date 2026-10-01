import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Vite emits <link rel="modulepreload"> for the entry's dependency graph,
    // which would make the browser DOWNLOAD the pdf/xlsx chunks on first paint
    // anyway — separate files, but the same bytes on the critical path, which
    // defeats the point of splitting them.
    //
    // The filter keeps preloading for chunks that are genuinely needed to
    // render (react, the app itself) and drops it for the export-only ones, so
    // they are fetched when someone first clicks Export instead.
    modulePreload: {
      resolveDependencies: (_url, deps) =>
        deps.filter(dep => !/\/(pdf|xlsx)-[^/]+\.js$/.test(dep)),
    },
    rollupOptions: {
      output: {
        // Split the heavy, rarely-needed libraries out of the main bundle.
        //
        // Everything used to land in ONE ~1.4 MB chunk, so a visitor opening
        // the Pipeline downloaded a PDF engine (jspdf + autotable + the fonts
        // it pulls), a spreadsheet writer (xlsx) and a screenshot library
        // (html2canvas) before the first row could render — none of which are
        // touched unless someone clicks Export or Print.
        //
        // manualChunks is used rather than relying on dynamic import() alone
        // because several modules (lib/invoicePdf.js, lib/quotationPdf.js,
        // Calls/Customers/CallbackTracker) import these statically, which pulls
        // them back into the main chunk however the call sites are written.
        // Splitting here is independent of that and cannot be undone by a
        // future static import somewhere new.
        //
        // The browser caches these separately, so a deploy that changes only
        // app code no longer invalidates ~600 kB of unchanged vendor payload.
        //
        // Written as a FUNCTION rather than the `{name: [...modules]}` object
        // form: Vite 8 builds with Rolldown, which accepts only the function
        // signature and fails the build outright with "manualChunks is not a
        // function" on the object. The function form is understood by both
        // Rollup (Vite 7) and Rolldown (Vite 8), so this works either side of
        // that upgrade.
        //
        // Matching on path segments rather than bare `includes(name)` so a
        // package whose name merely contains "xlsx" cannot be swept into the
        // wrong chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](jspdf|jspdf-autotable)[\\/]/.test(id)) return 'pdf';
          if (/[\\/]node_modules[\\/]xlsx[\\/]/.test(id)) return 'xlsx';
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react';
          return undefined;
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/__tests__/setup.js'],
    css: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        'src/__tests__/',
        '**/*.config.js',
        '**/main.jsx',
      ],
    },
  },
});
