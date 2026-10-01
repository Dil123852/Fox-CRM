// Shared display formatters for the dashboard UI.
//
// Deliberately separate from lib/pdfShared.js, which has its own
// formatDimension returning "72 x 60" (ASCII x, no unit) because the PDF
// layout measures text width and sets the unit in a neighbouring column.
// The two are NOT interchangeable: swapping one for the other silently
// changes rendered invoice and quotation output.

// A variant's dimension in the shape the current catalog stores it
// ("72x60" -> "72 × 60 in").
//
// Falls back to the raw string when it does not match, so an unexpected
// value still renders instead of vanishing.
export function formatDimension(dim) {
  const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(dim || '').trim());
  return m ? `${m[1]} × ${m[2]} in` : String(dim || '');
}

// The one field that identifies a variant, across both real shapes in the
// data: the current catalog uses {size, dimension, price} (dimension = exact
// WxL in inches), while the three retired products still use {size, height,
// price} (height = spring thickness). Pillows carry a price-only variant with
// neither, hence the '' fallback.
export function variantValue(v) {
  return v.dimension ?? v.height ?? v.size ?? '';
}
