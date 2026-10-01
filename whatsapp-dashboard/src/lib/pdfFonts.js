import montserratUrl from '../assets/fonts/Montserrat-Regular.ttf';
import openSansRegularUrl from '../assets/fonts/OpenSans-Regular.ttf';
import openSansSemiBoldUrl from '../assets/fonts/OpenSans-SemiBold.ttf';
import openSansBoldItalicUrl from '../assets/fonts/OpenSans-BoldItalic.ttf';

// Real Montserrat and Open Sans for the quotation, matching the design.
//
// jsPDF ships only the PDF standard 14 fonts (helvetica/times/courier), so a
// brand typeface has to be embedded in the document itself. Every file here
// is a STATIC, Latin-1-subset TTF:
//
//  - static, because jsPDF cannot read a variable font, and Google Fonts'
//    default download for both families is variable (`Montserrat[wght].ttf`)
//  - subset to U+0020–U+007E plus U+00A0–U+00FF, which takes each face from
//    ~120–180KB down to ~29–39KB (140KB for all four). The whole Latin-1
//    range is kept rather than only the characters in today's literals, so a
//    new customer name or product can never render as a missing glyph.
//
// Four faces, which is what the document actually draws: Montserrat regular
// for the EXPERIENCE CENTER title, Open Sans bold-italic for the address
// under it, and Open Sans regular + semibold for every heading, table cell
// and total on the page.

const FACES = [
  { file: 'Montserrat-Regular.ttf',  url: montserratUrl,          family: 'Montserrat', style: 'normal' },
  { file: 'OpenSans-Regular.ttf',    url: openSansRegularUrl,     family: 'OpenSans',   style: 'normal' },
  { file: 'OpenSans-SemiBold.ttf',   url: openSansSemiBoldUrl,    family: 'OpenSans',   style: 'bold' },
  { file: 'OpenSans-BoldItalic.ttf', url: openSansBoldItalicUrl,  family: 'OpenSans',   style: 'bolditalic' },
];

// jsPDF wants raw base64 (no data: prefix) in its virtual file system.
async function fetchBase64(url) {
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunked so a ~40KB font cannot blow the argument limit of String.fromCharCode.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

let cache;

// Registers the embedded faces on a jsPDF document. Resolves to true when the
// custom fonts are usable, false when they could not be loaded — the caller
// then falls back to Helvetica, because a missing typeface must degrade the
// document's looks, never block a customer's quotation.
export async function registerPdfFonts(doc) {
  try {
    if (!cache) {
      cache = await Promise.all(
        FACES.map(async f => ({ ...f, b64: await fetchBase64(f.url) }))
      );
    }
    for (const f of cache) {
      doc.addFileToVFS(f.file, f.b64);
      doc.addFont(f.file, f.family, f.style);
    }
    // Prove the registration took rather than trusting it: addFont() does not
    // throw on a font jsPDF cannot parse, and a silently-unregistered family
    // would fall back mid-document with no warning. Check every STYLE, not
    // just the family, since a missing weight is the same failure.
    const list = doc.getFontList();
    return FACES.every(f => (list[f.family] || []).includes(f.style));
  } catch (err) {
    console.warn('[quotation] custom fonts unavailable, falling back to Helvetica:', err);
    cache = undefined; // let a later attempt retry
    return false;
  }
}
