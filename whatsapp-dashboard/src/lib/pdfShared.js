import logoUrl from '../assets/nidikumba-logo.png';
import { businessDateParts } from './businessTime';
import signatureUrl from '../assets/sign.png';
import qrUrl from '../assets/qr-code.png';

// Everything the quotation and the invoice share: the palette, the page
// geometry, the letterhead, the letter-spacing helper and the signature block.
//
// Extracted rather than copied, because the two documents go to the same
// customers and must look like they came from the same company — a duplicated
// letterhead would drift the first time one of them is adjusted.

// ── palette ──
export const INK   = [58, 62, 60];    // body text
export const SOFT  = [122, 128, 125]; // labels and secondary text
export const MINT  = [193, 232, 220]; // the brand band
export const HAIR  = [230, 234, 232];
export const GREEN = [16, 185, 129];  // logo green, for the fallback wordmark

// ── page geometry (mm) ──
export const PAGE_W = 210;
export const M      = 20.8;           // side margin — the brand band's own edge
export const W      = PAGE_W - M * 2; // 168.4mm of content
export const RIGHT  = PAGE_W - M;
// The table gives its cells 5mm of left padding, so ITEM and the product names
// start at M + 5. Every other block of text uses this same edge so nothing
// sits 5mm out of line with the item column. The mint band and the rules keep
// using M: they span the table's full width.
export const CELL_PAD = 5;
export const TEXT_L   = M + CELL_PAD;

export const LETTERHEAD = {
  logo:    { x: 57.0, y: 19.9, w: 96.1, h: 19.2 }, // 5:1, matching the asset
  title:   { y: 43.5, size: 15.8 },                // Montserrat
  address: { y: 51.5, size: 8.8, leading: 4.4 },   // Open Sans bold-italic
};

export const money = n =>
  `${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// Sri Lanka calendar date, whatever the viewer's computer is set to.
const ymd = d => {
  const p = businessDateParts(d);
  const pad = n => String(n).padStart(2, '0');
  return [pad(p.day), pad(p.month), p.year];
};

export const dmy = d => ymd(d).join('.');

export const dmySlash = d => ymd(d).join('/');

export function formatDimension(dim) {
  const m = /^(\d+)\s*[xX×]\s*(\d+)$/.exec(String(dim || '').trim());
  return m ? `${m[1]} x ${m[2]}` : String(dim || '');
}

// Width of a letter-spaced run, so one can be centred or right-aligned.
export function trackedWidth(doc, text, gap) {
  return String(text).split('').reduce((w, c) => w + doc.getTextWidth(c) + gap, 0) - gap;
}

// Letter-spaced capitals, as every heading here uses. jsPDF has no
// letter-spacing, so each glyph is placed individually.
export function tracked(doc, text, x, y, gap = 1, align = 'left') {
  const w = trackedWidth(doc, text, gap);
  let cx = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  for (const c of String(text).split('')) {
    doc.text(c, cx, y);
    cx += doc.getTextWidth(c) + gap;
  }
  return w;
}

// jsPDF needs a data URI for addImage, so read a bundled asset once and cache
// it. Returns null when it cannot load — a missing image must never block a
// customer document, so each caller carries a typographic fallback.
const imageCache = new Map();
export async function loadImage(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  let result = null;
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    result = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch {
    result = null;
  }
  imageCache.set(url, result);
  return result;
}

export { logoUrl, signatureUrl, qrUrl };

// Logo, title and address, at their designed positions.
export function drawLetterhead(doc, { logo, titleFont, bodyFont }) {
  const L = LETTERHEAD;
  if (logo) {
    doc.addImage(logo, 'PNG', L.logo.x, L.logo.y, L.logo.w, L.logo.h);
  } else {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(30);
    doc.setTextColor(...GREEN);
    doc.text('nidiKUMBA', PAGE_W / 2, L.logo.y + L.logo.h * 0.78, { align: 'center' });
  }

  doc.setTextColor(...INK);
  doc.setFont(titleFont, 'normal');
  doc.setFontSize(L.title.size);
  tracked(doc, 'EXPERIENCE CENTER', PAGE_W / 2, L.title.y, 1, 'center');

  doc.setFont(bodyFont, 'bold');
  doc.setFontSize(L.address.size);
  doc.setTextColor(...SOFT);
  let ay = L.address.y;
  for (const line of ['No 23, Walukarama Road,', 'Colombo 03, Sri Lanka']) {
    tracked(doc, line, PAGE_W / 2, ay, 1, 'center');
    ay += L.address.leading;
  }
}

// Signature image over the signatory's three lines, plus the site URL on the
// left. Anchored UP from baseY so the lines sit at a fixed foot and the image
// floats above them however tall it is.
export function drawSignature(doc, { signature, bodyFont, baseY }) {
  const SIG_W = 34;
  const SIG = { w: SIG_W, h: SIG_W * 163 / 350 }; // the asset's real 350x163
  const nameY = baseY - 8.4;
  const roleY = baseY - 4.2;

  if (signature) {
    doc.addImage(signature, 'PNG', RIGHT - SIG.w, nameY - 3.6 - SIG.h, SIG.w, SIG.h);
  } else {
    // No signature asset: a ruled line to sign by hand, rather than a gap
    // that reads as something having failed to load.
    doc.setDrawColor(...HAIR);
    doc.setLineWidth(0.2);
    doc.line(RIGHT - 52, nameY - 4.5, RIGHT, nameY - 4.5);
  }

  doc.setFont(bodyFont, 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...INK);
  doc.text('S.H. Minoli Maduwanthi', RIGHT, nameY, { align: 'right' });

  doc.setFont(bodyFont, 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...SOFT);
  doc.text('Client Relationship Assistant', RIGHT, roleY, { align: 'right' });
  doc.text('Nidikumba Mattress', RIGHT, baseY, { align: 'right' });

  doc.setFont(bodyFont, 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(...INK);
  tracked(doc, 'www.nidikumba.shop', TEXT_L, baseY, 1.2);
}

// The terms, identical on both documents, with the warranty QR beside them.
// Only commitments the system actually backs: warranty_years is 12 across the
// current catalog, and the advance rule on a custom order is enforced
// server-side by PATCH /api/orders/:id.
//
// `validityLine` differs between the two — a quotation's prices expire, an
// invoice's are already agreed — so the caller supplies it.
// `extraLines` — document-specific terms after the standard ones (a
// quotation's promo-code conditions, migration 055).
export function drawTerms(doc, { bodyFont, y, validityLine, extraLines = [] }) {
  doc.setFont(bodyFont, 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  tracked(doc, 'TERMS', TEXT_L, y, 1.1);

  doc.setFont(bodyFont, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...INK);
  let ty = y + 5.6;
  const lines = [
    'Prices include a 12 year warranty on all Nidikumba mattresses and free delivery.',
    'A custom or made-to-order item requires an advance payment before production begins.',
    validityLine,
    ...(extraLines || []),
  ].filter(Boolean);
  // Full content width: the QR now sits beside the bank details instead, so
  // nothing on the right constrains these lines.
  for (const line of lines) {
    for (const wrapped of doc.splitTextToSize(line, W - CELL_PAD * 2)) {
      doc.text(wrapped, TEXT_L, ty);
      ty += 4.6;
    }
  }
  return ty;
}

// Bank details, identical on both documents, with the warranty QR beside
// them on the right.
export function drawBankDetails(doc, { bodyFont, y, qr }) {
  const QR = 22; // square — the asset is 2257x2257
  const qrX = RIGHT - QR;

  doc.setFont(bodyFont, 'bold');
  doc.setFontSize(10);
  doc.setTextColor(...INK);
  tracked(doc, 'BANK DETAILS', TEXT_L, y, 1.1);

  doc.setFont(bodyFont, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...INK);
  let by = y + 5.6;
  for (const line of [
    'Account Name : THE NATURAL CHOICE PVT LTD',
    'Account Number : 0002 1004 2776',
    'Bank Name : Sampath Bank',
    'Branch : Pettah',
  ]) {
    doc.text(line, TEXT_L, by);
    by += 4.6;
  }

  if (qr) {
    // Top-aligned with the BANK DETAILS heading, so the QR does not move if
    // an account line is ever added or removed.
    doc.addImage(qr, 'PNG', qrX, y - 3.4, QR, QR);
    doc.setFont(bodyFont, 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...SOFT);
    doc.text('Scan for warranty details', qrX + QR / 2, y - 3.4 + QR + 3.2, { align: 'center' });
  }

  // The QR block runs lower than four account lines, so return whichever is
  // deeper — the signature below is pinned, but a caller that flows from this
  // must clear the image, not just the text.
  return Math.max(by, qr ? y - 3.4 + QR + 6 : by);
}
