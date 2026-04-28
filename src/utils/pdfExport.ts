// Build a fillable PDF (AcroForm) for a single CRF. Fields are real PDF
// form widgets so the document can be filled in Acrobat / Preview / browser
// PDF viewers and the answers persist.
//
// Layout: single-column, letter portrait, 50pt margins. Sections render as
// bold uppercase headers; fields render as label-on-top with the input
// widget below. We page-break before any field that wouldn't fit on the
// current page (no mid-field splitting).
//
// pdf-lib is dynamic-imported by the caller so the ~150KB library only
// downloads when a user actually exports a PDF.

import { splitPipe, type CrfRecord } from '@/types';
import type {
  PDFDocument,
  PDFFont,
  PDFForm,
  PDFImage,
  PDFPage,
} from 'pdf-lib';
import logoUrl from '@/assets/pennsieve-logo.svg?url';

export interface PdfCdeInput {
  cde_name: string;
  cde_data_type: string;
  cde_definition: string | null;
  preferred_question_text: string | null;
  variable_name: string | null;
  unit_of_measure: string | null;
  pv_labels: string | null;
  pv_codes: string | null;
  min_value: number | null;
  max_value: number | null;
  classification_agnostic: string | null;
  classification_neurotrauma: string | null;
  classification_tbi: string | null;
  classification_pte: string | null;
  classification_sci: string | null;
  classification_epilepsy: string | null;
}

export interface PdfBundleInput {
  bundle_name: string;
  cdes: PdfCdeInput[];
}

// Letter portrait, in points (1pt = 1/72 inch).
const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;
// Footer is fixed-height; subtract from the body cursor's lower bound so
// content never lands on top of the footer line.
const FOOTER_HEIGHT = 28;
const BODY_BOTTOM = MARGIN + FOOTER_HEIGHT;

// Typography. Standard (Type 1) fonts so we don't have to embed.
const TITLE_SIZE = 18;
const BODY_SIZE = 10;
const LABEL_SIZE = 10;
const META_SIZE = 8;
const SECTION_SIZE = 11;
const LINE_HEIGHT = 1.4;
const RADIO_DOT = 10; // square px for the option widget

/** Map disease scope to the matching `classification_<key>` column. Mirrors
 *  the JSON Schema exporter's logic so PDF "required" decisions stay in
 *  sync. Returns null when the scope is unrecognized. */
function diseaseKeyFromScope(scope: string | null | undefined): string | null {
  if (!scope) return null;
  const s = scope.trim().toLowerCase();
  const map: Array<{ key: string; needles: string[] }> = [
    { key: 'pte', needles: ['post-traumatic epilepsy', 'pte'] },
    { key: 'tbi', needles: ['traumatic brain injury', 'tbi'] },
    { key: 'sci', needles: ['spinal cord injury', 'sci'] },
    { key: 'neurotrauma', needles: ['neurotrauma'] },
    { key: 'epilepsy', needles: ['epilepsy'] },
    { key: 'agnostic', needles: ['agnostic', 'disease-agnostic'] },
  ];
  for (const { key, needles } of map) {
    if (needles.some((n) => s.includes(n))) return key;
  }
  return null;
}

const CLASSIFICATION_COLS: Array<keyof PdfCdeInput> = [
  'classification_agnostic',
  'classification_neurotrauma',
  'classification_tbi',
  'classification_pte',
  'classification_sci',
  'classification_epilepsy',
];

function effectiveTier(
  cde: PdfCdeInput,
  diseaseKey: string | null,
): 'Core' | 'Recommended' | 'Supplemental' | null {
  if (diseaseKey) {
    const v = cde[`classification_${diseaseKey}` as keyof PdfCdeInput] as
      | string
      | null
      | undefined;
    if (v === 'Core' || v === 'Recommended' || v === 'Supplemental') return v;
    return null;
  }
  const tiers = CLASSIFICATION_COLS.map((c) => cde[c] as string | null);
  if (tiers.includes('Core')) return 'Core';
  if (tiers.includes('Recommended')) return 'Recommended';
  if (tiers.includes('Supplemental')) return 'Supplemental';
  return null;
}

/** Wrap `text` to fit `maxWidth` at `size` using `font`. Returns lines. */
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  if (!text) return [];
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const w of words) {
      const candidate = current ? `${current} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        lines.push(current);
        current = w;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** Whitespace-and-punctuation-insensitive equivalence check. Used to
 *  suppress the definition sub-line when it duplicates the preferred
 *  question text (common on "specify other" free-text CDEs). */
function textsEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[.,;:!?'"`]/g, '')
      .trim();
  return norm(a) === norm(b);
}

/** Sanitize text so pdf-lib's WinAnsi encoding doesn't choke on smart quotes,
 *  em-dashes, etc. Lossy by design — replaces with ASCII equivalents. */
function safe(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/–|—/g, '-')
    .replace(/…/g, '...')
    .replace(/·/g, '·')
    // Drop anything still outside printable ASCII + common Latin-1 supplement.
    .replace(/[^\x09\x0A\x0D\x20-\x7E\xA0-\xFF]/g, '');
}

/** PDF AcroForm field names must be unique within the document and
 *  shouldn't collide with PDF keywords. Slug + uniquify. */
function toFieldName(raw: string, taken: Set<string>): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'x_$1') || 'field';
  let name = slug;
  let i = 2;
  while (taken.has(name)) name = `${slug}_${i++}`;
  taken.add(name);
  return name;
}

interface Cursor {
  doc: PDFDocument;
  form: PDFForm;
  page: PDFPage;
  font: PDFFont;
  fontBold: PDFFont;
  y: number;
  taken: Set<string>;
}

function newPage(c: Cursor): void {
  c.page = c.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  c.y = PAGE_HEIGHT - MARGIN;
}

/** Reserve `needed` vertical space; if not enough, push a new page. The
 *  `BODY_BOTTOM` floor leaves room for the page footer that's drawn at the
 *  end. */
function ensureSpace(c: Cursor, needed: number): void {
  if (c.y - needed < BODY_BOTTOM) newPage(c);
}

/** Render the imported Pennsieve SVG to a PNG byte array via an offscreen
 *  canvas. Done once per export; pdf-lib only accepts PNG/JPEG. The width
 *  here is the rasterized resolution — actual placement size is decided
 *  when we draw the image. */
async function loadLogoPng(width = 240, fill = '#777777'): Promise<Uint8Array> {
  const img = new Image();
  img.src = logoUrl;
  await img.decode();
  const ratio = img.naturalHeight / img.naturalWidth;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(width * ratio);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  // Render the logo as a single solid color silhouette. We draw the SVG
  // first to capture its alpha mask, then composite-in a flat fill so every
  // colored region (blue/orange/gold + gradient) collapses to one tone.
  // Cleaner than CSS grayscale, which always leaves luminance variations.
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  );
  return new Uint8Array(await blob.arrayBuffer());
}

interface FooterContext {
  logo: PDFImage;
  font: PDFFont;
  crfTitle: string;
  crfVersion: string;
  generatedDate: string;
}

/** Accent color for the thin bar under the CRF title. Disease-specific so
 *  the form's scope reads at a glance — same palette spirit as the badges
 *  used elsewhere in the app. Falls back to slate for unrecognized scopes. */
function diseaseAccentColor(scope: string | null | undefined): {
  r: number;
  g: number;
  b: number;
} {
  const key = (scope ?? '').toLowerCase();
  // Hex values converted to 0..1 RGB at use time.
  const hex = ((): string => {
    if (key.includes('post-traumatic epilepsy') || key.includes('pte')) return '#be185d';
    if (key.includes('traumatic brain injury') || key.includes('tbi')) return '#b45309';
    if (key.includes('spinal cord injury') || key.includes('sci')) return '#0ea5a3';
    if (key.includes('neurotrauma')) return '#475569';
    if (key.includes('epilepsy')) return '#7c3aed';
    if (key.includes('agnostic')) return '#1f528f';
    return '#475569';
  })();
  const n = parseInt(hex.slice(1), 16);
  return {
    r: ((n >> 16) & 0xff) / 255,
    g: ((n >> 8) & 0xff) / 255,
    b: (n & 0xff) / 255,
  };
}

/** Draw the footer on every page once the document is complete. We need to
 *  do this after pagination is finalized so "Page X of Y" is accurate. */
function drawFooters(doc: PDFDocument, ctx: FooterContext): void {
  const pages = doc.getPages();
  const total = pages.length;
  // Logo size: scale to ~14pt tall — small enough to stay subtle.
  const logoH = 14;
  const logoW = (ctx.logo.width / ctx.logo.height) * logoH;
  // Subtle grey for both logo and text — pdf-lib mixes the opacity with the
  // existing colours, which makes the multi-tone Pennsieve mark read as
  // muted gray.
  const grey = { type: 'RGB' as const, red: 0.55, green: 0.55, blue: 0.55 };

  for (let i = 0; i < total; i++) {
    const page = pages[i];
    const baselineY = MARGIN - 6;

    // Top hairline divider above the footer for visual separation.
    page.drawLine({
      start: { x: MARGIN, y: MARGIN + 14 },
      end: { x: PAGE_WIDTH - MARGIN, y: MARGIN + 14 },
      thickness: 0.3,
      color: { type: 'RGB', red: 0.8, green: 0.8, blue: 0.8 } as any,
    });

    // Left: just the logo. Solid grey at full opacity reads cleaner than a
    // colorful logo dimmed via opacity.
    page.drawImage(ctx.logo, {
      x: MARGIN,
      y: baselineY - 1,
      width: logoW,
      height: logoH,
    });

    // Center: CRF title (truncated) + date.
    const middleText = `${ctx.crfTitle}  ·  ${ctx.generatedDate}`;
    const middleWidth = ctx.font.widthOfTextAtSize(middleText, 7);
    page.drawText(middleText, {
      x: (PAGE_WIDTH - middleWidth) / 2,
      y: baselineY + 2,
      size: 7,
      font: ctx.font,
      color: grey as any,
    });

    // Right: version (when set) + page number, so reviewers know exactly
    // which revision of the form they're looking at on a printout.
    const pageText = ctx.crfVersion
      ? `v${ctx.crfVersion}  ·  Page ${i + 1} of ${total}`
      : `Page ${i + 1} of ${total}`;
    const pageWidth = ctx.font.widthOfTextAtSize(pageText, 7);
    page.drawText(pageText, {
      x: PAGE_WIDTH - MARGIN - pageWidth,
      y: baselineY + 2,
      size: 7,
      font: ctx.font,
      color: grey as any,
    });
  }
}

function drawWrapped(
  c: Cursor,
  text: string,
  size: number,
  font: PDFFont,
  color?: { r: number; g: number; b: number },
): void {
  const lines = wrapText(safe(text), font, size, CONTENT_WIDTH);
  const lineH = size * LINE_HEIGHT;
  for (const line of lines) {
    ensureSpace(c, lineH);
    c.page.drawText(line, {
      x: MARGIN,
      y: c.y - size,
      size,
      font,
      color: color
        ? // pdf-lib's Color type — built lazily so we don't have to import it.
          ({ type: 'RGB', red: color.r, green: color.g, blue: color.b } as any)
        : undefined,
    });
    c.y -= lineH;
  }
}

/** Render the CRF's procedural instructions as a visually distinct block:
 *  small-caps "INSTRUCTIONS" header + indented body with a thin accent rule
 *  on the left. Sets it apart from the freeform description and signals to
 *  the reader that this is action-oriented guidance for filling the form. */
function drawInstructionsBlock(c: Cursor, instructions: string): void {
  const indent = 12;
  const ruleX = MARGIN + 2;
  const textX = MARGIN + indent;
  const innerWidth = CONTENT_WIDTH - indent;
  const grey = { type: 'RGB' as const, red: 0.45, green: 0.45, blue: 0.45 };
  const ruleColor = { type: 'RGB' as const, red: 0.7, green: 0.7, blue: 0.7 };

  // Header
  ensureSpace(c, META_SIZE * LINE_HEIGHT + 4);
  c.page.drawText('INSTRUCTIONS', {
    x: textX,
    y: c.y - META_SIZE,
    size: META_SIZE,
    font: c.fontBold,
    color: grey as any,
  });
  c.y -= META_SIZE * LINE_HEIGHT + 2;

  // Body — wrapped to the indented width, drawn in grey.
  const lines = wrapText(safe(instructions), c.font, BODY_SIZE, innerWidth);
  const blockTop = c.y;
  const lineH = BODY_SIZE * LINE_HEIGHT;
  for (const line of lines) {
    ensureSpace(c, lineH);
    c.page.drawText(line, {
      x: textX,
      y: c.y - BODY_SIZE,
      size: BODY_SIZE,
      font: c.font,
      color: grey as any,
    });
    c.y -= lineH;
  }

  // Left accent rule alongside the body — drawn last so it spans the whole
  // block on this page. (If pagination kicked in mid-block, the rule only
  // marks the portion above the break — acceptable trade for simplicity.)
  c.page.drawLine({
    start: { x: ruleX, y: c.y + 1 },
    end: { x: ruleX, y: blockTop + 1 },
    thickness: 1.5,
    color: ruleColor as any,
  });
  c.y -= 2;
}

function drawSection(c: Cursor, label: string): void {
  c.y -= 8; // breathing room above
  ensureSpace(c, SECTION_SIZE * LINE_HEIGHT + 6);
  c.page.drawText(safe(label).toUpperCase(), {
    x: MARGIN,
    y: c.y - SECTION_SIZE,
    size: SECTION_SIZE,
    font: c.fontBold,
  });
  c.y -= SECTION_SIZE * LINE_HEIGHT;
  // underline
  c.page.drawLine({
    start: { x: MARGIN, y: c.y + 2 },
    end: { x: MARGIN + CONTENT_WIDTH, y: c.y + 2 },
    thickness: 0.5,
  });
  c.y -= 6;
}

function drawCdeField(
  c: Cursor,
  cde: PdfCdeInput,
  required: boolean,
): void {
  const labels = splitPipe(cde.pv_labels);
  const codes = splitPipe(cde.pv_codes);
  const isValueList = (cde.cde_data_type ?? '').toLowerCase() === 'value list' && labels.length;

  const questionText = (cde.preferred_question_text || cde.cde_name) +
    (required ? ' *' : '');
  const labelLines = wrapText(safe(questionText), c.fontBold, LABEL_SIZE, CONTENT_WIDTH);
  const labelHeight = labelLines.length * LABEL_SIZE * LINE_HEIGHT;

  // Optional small grey definition line under the label. Skip when it's a
  // duplicate of the question text — some CDEs (especially "specify other"
  // free-text fields) use the exact same paragraph for both, which made
  // every such row read the same prose twice in a row.
  const showDef = cde.cde_definition && !textsEquivalent(cde.preferred_question_text, cde.cde_definition);
  const def = showDef ? wrapText(safe(cde.cde_definition!), c.font, META_SIZE, CONTENT_WIDTH) : [];
  const defHeight = def.length * META_SIZE * LINE_HEIGHT;

  const dt = (cde.cde_data_type ?? '').toLowerCase();
  const isDatetime = dt === 'datetime';

  // Widget height: text fields ~22pt; radios ~22 per option (capped to 6
  // options before falling through to dropdown for compactness). Datetime
  // CDEs render as two side-by-side fields with sub-labels underneath, so
  // they reserve a few extra pt for the "Date" / "Time" captions.
  let widgetHeight: number;
  let useDropdown = false;
  if (isValueList) {
    if (labels.length > 6) {
      useDropdown = true;
      widgetHeight = 22;
    } else {
      widgetHeight = labels.length * (RADIO_DOT + 6);
    }
  } else if (isDatetime) {
    widgetHeight = 22 + META_SIZE * LINE_HEIGHT;
  } else {
    widgetHeight = 22;
  }

  const totalHeight = labelHeight + 2 + defHeight + 4 + widgetHeight + 12;
  ensureSpace(c, totalHeight);

  // Label
  for (const line of labelLines) {
    c.page.drawText(line, {
      x: MARGIN,
      y: c.y - LABEL_SIZE,
      size: LABEL_SIZE,
      font: c.fontBold,
    });
    c.y -= LABEL_SIZE * LINE_HEIGHT;
  }

  // Definition (small grey)
  for (const line of def) {
    c.page.drawText(line, {
      x: MARGIN,
      y: c.y - META_SIZE,
      size: META_SIZE,
      font: c.font,
    });
    c.y -= META_SIZE * LINE_HEIGHT;
  }
  c.y -= 4;

  const fieldName = toFieldName(cde.variable_name || cde.cde_name, c.taken);

  if (isValueList && useDropdown) {
    // Long Value List → dropdown widget. Show "code: label" only when the
    // code adds information; collapse to the label alone when they're the
    // same (avoids "Unknown: Unknown" repetition).
    const dropdown = c.form.createDropdown(fieldName);
    dropdown.setOptions(
      labels.map((label, i) => {
        const code = codes[i];
        if (!code || code === label) return label;
        return `${code}: ${label}`;
      }),
    );
    dropdown.addToPage(c.page, {
      x: MARGIN,
      y: c.y - widgetHeight,
      width: CONTENT_WIDTH,
      height: widgetHeight,
      borderWidth: 0.5,
    });
    if (required) dropdown.enableRequired();
    c.y -= widgetHeight + 8;
  } else if (isValueList && labels.length === 1) {
    // Single-option Value List → checkbox. A radio group of one can only
    // ever be set, never cleared, so the user can't undo a stray click.
    // A checkbox toggles cleanly.
    const checkbox = c.form.createCheckBox(fieldName);
    const optY = c.y - RADIO_DOT;
    checkbox.addToPage(c.page, {
      x: MARGIN,
      y: optY,
      width: RADIO_DOT,
      height: RADIO_DOT,
    });
    c.page.drawText(safe(labels[0]), {
      x: MARGIN + RADIO_DOT + 6,
      y: optY + 1,
      size: BODY_SIZE,
      font: c.font,
    });
    if (required) checkbox.enableRequired();
    c.y -= widgetHeight + 8;
  } else if (isValueList) {
    // Short Value List → radio group.
    const radio = c.form.createRadioGroup(fieldName);
    for (let i = 0; i < labels.length; i++) {
      const optY = c.y - RADIO_DOT - i * (RADIO_DOT + 6);
      radio.addOptionToPage(`${codes[i] ?? labels[i]}`, c.page, {
        x: MARGIN,
        y: optY,
        width: RADIO_DOT,
        height: RADIO_DOT,
      });
      // Option label next to the dot.
      c.page.drawText(safe(labels[i]), {
        x: MARGIN + RADIO_DOT + 6,
        y: optY + 1,
        size: BODY_SIZE,
        font: c.font,
      });
    }
    if (required) radio.enableRequired();
    c.y -= widgetHeight + 8;
  } else if (isDatetime) {
    // Split into two adjacent text fields: Date (YYYY-MM-DD) and
    // Time (HH:MM). Easier to fill on paper or in viewers than a single
    // free-form datetime string.
    const inputH = 22;
    const gap = 8;
    const fieldW = (CONTENT_WIDTH - gap) / 2;
    const dateField = c.form.createTextField(`${fieldName}_date`);
    const timeField = c.form.createTextField(`${fieldName}_time`);
    dateField.addToPage(c.page, {
      x: MARGIN,
      y: c.y - inputH,
      width: fieldW,
      height: inputH,
      borderWidth: 0.5,
    });
    timeField.addToPage(c.page, {
      x: MARGIN + fieldW + gap,
      y: c.y - inputH,
      width: fieldW,
      height: inputH,
      borderWidth: 0.5,
    });
    if (required) {
      dateField.enableRequired();
      timeField.enableRequired();
    }
    c.y -= inputH + 2;

    // Sub-labels under each input — explicit format so the data collector
    // doesn't have to guess.
    c.page.drawText('Date  (YYYY-MM-DD)', {
      x: MARGIN,
      y: c.y - META_SIZE,
      size: META_SIZE,
      font: c.font,
    });
    c.page.drawText('Time  (HH:MM, 24-hour)', {
      x: MARGIN + fieldW + gap,
      y: c.y - META_SIZE,
      size: META_SIZE,
      font: c.font,
    });
    c.y -= META_SIZE * LINE_HEIGHT;
  } else {
    // Text field for everything else (text, number, date, time).
    const text = c.form.createTextField(fieldName);
    text.addToPage(c.page, {
      x: MARGIN,
      y: c.y - widgetHeight,
      width: CONTENT_WIDTH,
      height: widgetHeight,
      borderWidth: 0.5,
    });
    if (required) text.enableRequired();
    c.y -= widgetHeight + 4;

    // Hint line under the input: explicit format for date/time, plus unit
    // and range when applicable.
    const hints: string[] = [];
    if (dt === 'date') hints.push('Format: YYYY-MM-DD');
    else if (dt === 'time') hints.push('Format: HH:MM (24-hour)');
    else if (dt === 'number') hints.push('number');
    else if (dt === 'file/uri/url') hints.push('URL or file path');
    else if (dt === 'geolocation') hints.push('lat, lon (decimal degrees)');
    if (cde.unit_of_measure) hints.push(`unit: ${cde.unit_of_measure}`);
    if (cde.min_value != null || cde.max_value != null) {
      const lo = cde.min_value != null ? String(cde.min_value) : '-inf';
      const hi = cde.max_value != null ? String(cde.max_value) : 'inf';
      hints.push(`range: ${lo} to ${hi}`);
    }
    if (hints.length) {
      c.page.drawText(safe(hints.join('  ·  ')), {
        x: MARGIN,
        y: c.y - META_SIZE,
        size: META_SIZE,
        font: c.font,
      });
      c.y -= META_SIZE * LINE_HEIGHT;
    }
    c.y -= 4;
  }

  c.y -= 4; // gap between fields
}

export async function buildCrfPdf(
  crf: CrfRecord,
  cdesByRef: Map<string, PdfCdeInput>,
  bundlesByRef: Map<string, PdfBundleInput>,
): Promise<{ bytes: Uint8Array; fieldCount: number; missingRefs: string[] }> {
  // Dynamic import so pdf-lib only loads when the user actually exports.
  const { PDFDocument, StandardFonts } = await import('pdf-lib');

  const doc = await PDFDocument.create();
  doc.setTitle(crf.title);
  doc.setSubject(crf.description ?? '');
  doc.setProducer('Pennsieve CDE Review Dashboard');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();

  const c: Cursor = {
    doc,
    form,
    page: doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]),
    font,
    fontBold,
    y: PAGE_HEIGHT - MARGIN,
    taken: new Set<string>(),
  };

  // Header: title + accent rule + meta line + description + instructions.
  // The accent rule is colored by disease scope so the form's clinical
  // context reads at a glance. Subtle (1.5pt) so it's a marker, not a banner.
  c.page.drawText(safe(crf.title), {
    x: MARGIN,
    y: c.y - TITLE_SIZE,
    size: TITLE_SIZE,
    font: c.fontBold,
  });
  c.y -= TITLE_SIZE * LINE_HEIGHT;

  // Short accent bar under the title — intentional, reads as a punctuation
  // mark rather than an underline. Sits a few pts below the title's
  // descender line and runs ~100pt so it's visible but doesn't compete
  // with the title length.
  const accent = diseaseAccentColor(crf.disease_scope);
  c.y -= 2;
  c.page.drawLine({
    start: { x: MARGIN, y: c.y },
    end: { x: MARGIN + 100, y: c.y },
    thickness: 2,
    color: { type: 'RGB', red: accent.r, green: accent.g, blue: accent.b } as any,
  });
  c.y -= 6;

  const metaParts: string[] = [];
  if (crf.disease_scope) metaParts.push(crf.disease_scope);
  if (crf.version) metaParts.push(`v${crf.version}`);
  if (crf.estimated_duration_minutes) metaParts.push(`~${crf.estimated_duration_minutes} min`);
  if (metaParts.length) {
    c.page.drawText(safe(metaParts.join('  ·  ')), {
      x: MARGIN,
      y: c.y - META_SIZE,
      size: META_SIZE,
      font: c.font,
    });
    c.y -= META_SIZE * LINE_HEIGHT;
  }

  c.y -= 6;
  if (crf.description) drawWrapped(c, crf.description, BODY_SIZE, c.font);
  if (crf.instructions) {
    c.y -= 8;
    drawInstructionsBlock(c, crf.instructions);
  }
  c.y -= 12;

  const diseaseKey = diseaseKeyFromScope(crf.disease_scope);
  const missingRefs: string[] = [];
  let fieldCount = 0;

  for (const item of crf.items) {
    if (item.type === 'section') {
      drawSection(c, item.label ?? 'Section');
      if (item.instructions) drawWrapped(c, item.instructions, META_SIZE, c.font);
      continue;
    }
    if (item.type === 'cde' && item.ref) {
      const cde = cdesByRef.get(item.ref);
      if (!cde) {
        missingRefs.push(`cde:${item.ref}`);
        continue;
      }
      const required = effectiveTier(cde, diseaseKey) === 'Core';
      drawCdeField(c, cde, required);
      fieldCount++;
      continue;
    }
    if (item.type === 'bundle' && item.ref) {
      const bundle = bundlesByRef.get(item.ref);
      if (!bundle) {
        missingRefs.push(`bundle:${item.ref}`);
        continue;
      }
      // Render the bundle as an italicized sub-header, then its members.
      ensureSpace(c, BODY_SIZE * LINE_HEIGHT + 4);
      c.page.drawText(safe(`▸ ${bundle.bundle_name}`), {
        x: MARGIN,
        y: c.y - BODY_SIZE,
        size: BODY_SIZE,
        font: c.fontBold,
      });
      c.y -= BODY_SIZE * LINE_HEIGHT + 2;
      for (const cde of bundle.cdes) {
        const required = effectiveTier(cde, diseaseKey) === 'Core';
        drawCdeField(c, cde, required);
        fieldCount++;
      }
    }
  }

  // Tell every form field how to render itself by giving the form a
  // default font. pdf-lib walks the field tree and writes /DA entries so
  // viewers (Acrobat, Preview, browser) draw user-entered text correctly.
  // Without this, pdf-lib throws "No /DA entry found for field: X" on save.
  form.updateFieldAppearances(font);

  // Load + embed the Pennsieve logo once, then stamp the footer on every
  // page. Done after content is fully laid out so "Page X of Y" is right.
  try {
    const logoBytes = await loadLogoPng();
    const logo = await doc.embedPng(logoBytes);
    drawFooters(doc, {
      logo,
      font,
      crfTitle: safe(crf.title),
      crfVersion: safe(crf.version ?? ''),
      generatedDate: new Date().toISOString().slice(0, 10),
    });
  } catch {
    // If the logo can't be loaded (e.g. tests, headless), fall back to a
    // text-only footer so the PDF still ships.
    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      pages[i].drawText(
        `Generated by Pennsieve  ·  ${safe(crf.title)}  ·  Page ${i + 1} of ${pages.length}`,
        {
          x: MARGIN,
          y: MARGIN - 6,
          size: 7,
          font,
          color: { type: 'RGB', red: 0.55, green: 0.55, blue: 0.55 } as any,
        },
      );
    }
  }

  const bytes = await doc.save();
  return { bytes, fieldCount, missingRefs };
}

export function downloadCrfPdf(crf: CrfRecord, bytes: Uint8Array) {
  const name = (crf.crf_name || crf.title).replace(/\s+/g, '_');
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
