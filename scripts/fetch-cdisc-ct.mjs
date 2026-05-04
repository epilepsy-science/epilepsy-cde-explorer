#!/usr/bin/env node
// Fetch and parse CDISC Controlled Terminology from the NCI EVS FTP server.
//
// Why NCI EVS: the same content the CDISC Library API gates behind member-tier
// is co-published by NCI (which maintains the canonical NCIt encoding for every
// codelist) under public-domain-compatible terms. Quote from
// cancer.gov/about-nci/organization/cbiit/vocabulary/cdisc:
//   "You can use CDISC Terminology for free, without licensing restrictions."
//   "In the case of permitted digital reproduction, please credit the National
//    Cancer Institute as the source."
//
// We require the dashboard's UI to surface that credit anywhere CDISC CT data
// is rendered (badge, footer, or detail-drawer attribution line).
//
// Source ODM-XML covers the entire CDISC CT — SDTM, CDASH, ADaM, SEND, QRS,
// Define-XML — in one ~25 MB file. We pull just the SDTM file because it's
// the union package; CDISC publishes per-product files but the SDTM one
// contains all base codelists. Quarterly NCI releases.
//
// All outputs are gitignored / regenerable on every build, so the repo
// stays small and quarterly NCI updates flow in automatically:
//   data/cdisc-ct/raw/SDTM-Terminology.odm.xml     — cached XML download
//   data/cdisc-ct/{codelist,codelist_item}.jsonl   — parsed intermediate
//   public/data/cdisc-ct/{codelist,codelist_item}.parquet — runtime data
//   public/data/cdisc-ct/manifest.json             — version + attribution
//
// Hooked into `yarn prepare-data` so Amplify builds always include the
// latest CT.
//
// Usage:
//   node scripts/fetch-cdisc-ct.mjs            # use cache if present
//   node scripts/fetch-cdisc-ct.mjs --refresh  # force re-download

import duckdb from 'duckdb';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'data/cdisc-ct');
const RAW_DIR = resolve(OUT_DIR, 'raw');
const RAW_FILE = resolve(RAW_DIR, 'SDTM-Terminology.odm.xml');
const PARQUET_DIR = resolve(ROOT, 'public/data/cdisc-ct');
const SOURCE_URL =
  'https://evs.nci.nih.gov/ftp1/CDISC/SDTM/SDTM%20Terminology.odm.xml';

const ATTRIBUTION =
  'CDISC Terminology was originally published by the National Cancer Institute.';

const refresh = process.argv.includes('--refresh');

mkdirSync(RAW_DIR, { recursive: true });

// ── Fetch ───────────────────────────────────────────────────────────────────

async function fetchIfNeeded() {
  if (!refresh && existsSync(RAW_FILE)) {
    const sizeMb = (statSync(RAW_FILE).size / 1024 / 1024).toFixed(1);
    console.log(`Cache hit: ${RAW_FILE} (${sizeMb} MB). Use --refresh to re-download.`);
    return;
  }
  console.log(`Downloading ${SOURCE_URL} …`);
  const t0 = Date.now();
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} from NCI EVS`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(RAW_FILE, buf);
  console.log(`  → wrote ${(buf.length / 1024 / 1024).toFixed(1)} MB in ${(
    (Date.now() - t0) /
    1000
  ).toFixed(1)} s`);
}

// ── Parse ───────────────────────────────────────────────────────────────────
// The ODM-XML has a flat structure:
//   <CodeList OID Name DataType nciodm:ExtCodeID nciodm:CodeListExtensible>
//     <Description><TranslatedText>…</TranslatedText></Description>
//     <EnumeratedItem CodedValue nciodm:ExtCodeID>
//       <nciodm:CDISCSynonym>…</nciodm:CDISCSynonym>  (repeating)
//       <nciodm:CDISCDefinition>…</nciodm:CDISCDefinition>
//       <nciodm:PreferredTerm>…</nciodm:PreferredTerm>
//     </EnumeratedItem>
//     …
//   </CodeList>
//
// We use a lightweight regex iterator since the format is regular and CDISC
// has held this shape across many quarterly releases. If parse counts ever
// drop unexpectedly, reach for a real XML parser.

const TAG_OPEN = /<CodeList\b([^>]*)>/g;
const TAG_CLOSE = '</CodeList>';
const ATTR = /([\w:-]+)="((?:[^"\\]|\\.)*)"/g;
const ITEM_RE = /<EnumeratedItem\b([^>]*)>([\s\S]*?)<\/EnumeratedItem>/g;
const DESC_RE = /<Description>\s*<TranslatedText[^>]*>([\s\S]*?)<\/TranslatedText>\s*<\/Description>/;
const SYN_RE = /<nciodm:CDISCSynonym>([\s\S]*?)<\/nciodm:CDISCSynonym>/g;
const DEF_RE = /<nciodm:CDISCDefinition>([\s\S]*?)<\/nciodm:CDISCDefinition>/;
const PT_RE = /<nciodm:PreferredTerm>([\s\S]*?)<\/nciodm:PreferredTerm>/;

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw) {
  const out = {};
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(raw)) !== null) {
    out[m[1]] = decodeEntities(m[2]);
  }
  return out;
}

function parse() {
  const xml = readFileSync(RAW_FILE, 'utf8');

  // Pull the publication date stamp from the ODM header so the manifest
  // records the exact CT release.
  const versionMatch = xml.match(/AsOfDateTime="([^"]+)"/);
  const ctVersion = versionMatch ? versionMatch[1].slice(0, 10) : null;

  const codelists = [];
  const items = [];

  TAG_OPEN.lastIndex = 0;
  let match;
  while ((match = TAG_OPEN.exec(xml)) !== null) {
    const openEnd = match.index + match[0].length;
    const closeIdx = xml.indexOf(TAG_CLOSE, openEnd);
    if (closeIdx < 0) break;
    const inner = xml.slice(openEnd, closeIdx);

    const attrs = parseAttrs(match[1]);
    const codelistOid = attrs.OID;
    const nciCode = attrs['nciodm:ExtCodeID'] ?? null;
    const description = (() => {
      const m = inner.match(DESC_RE);
      return m ? decodeEntities(m[1].trim()) : null;
    })();

    codelists.push({
      codelist_oid: codelistOid,
      codelist_short_name: codelistOid?.split('.').pop() ?? null,
      codelist_nci_code: nciCode,
      codelist_name: attrs.Name ?? null,
      data_type: attrs.DataType ?? null,
      extensible: attrs['nciodm:CodeListExtensible'] === 'Yes',
      description,
    });

    let im;
    ITEM_RE.lastIndex = 0;
    while ((im = ITEM_RE.exec(inner)) !== null) {
      const itemAttrs = parseAttrs(im[1]);
      const itemInner = im[2];
      const synonyms = [];
      let sm;
      SYN_RE.lastIndex = 0;
      while ((sm = SYN_RE.exec(itemInner)) !== null) {
        synonyms.push(decodeEntities(sm[1].trim()));
      }
      const defMatch = itemInner.match(DEF_RE);
      const ptMatch = itemInner.match(PT_RE);
      items.push({
        codelist_oid: codelistOid,
        codelist_short_name: codelistOid?.split('.').pop() ?? null,
        coded_value: itemAttrs.CodedValue ?? null,
        nci_code: itemAttrs['nciodm:ExtCodeID'] ?? null,
        preferred_term: ptMatch ? decodeEntities(ptMatch[1].trim()) : null,
        definition: defMatch ? decodeEntities(defMatch[1].trim()) : null,
        synonyms: synonyms.length ? synonyms.join('|') : null,
      });
    }

    TAG_OPEN.lastIndex = closeIdx;
  }

  return { ctVersion, codelists, items };
}

// ── Emit ────────────────────────────────────────────────────────────────────

async function emit({ ctVersion, codelists, items }) {
  mkdirSync(PARQUET_DIR, { recursive: true });

  // Intermediate JSONL (gitignored) — required because DuckDB's read_json
  // wants a file. Smaller than the XML so the round-trip is quick.
  const codelistJsonl = resolve(OUT_DIR, 'codelist.jsonl');
  const itemJsonl = resolve(OUT_DIR, 'codelist_item.jsonl');
  writeFileSync(codelistJsonl, codelists.map((r) => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(itemJsonl, items.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const db = new duckdb.Database(':memory:');
  const conn = db.connect();
  const run = (sql) =>
    new Promise((res, rej) => conn.run(sql, (e) => (e ? rej(e) : res())));

  const codelistParquet = resolve(PARQUET_DIR, 'codelist.parquet');
  const itemParquet = resolve(PARQUET_DIR, 'codelist_item.parquet');
  await run(`
    COPY (
      SELECT * FROM read_json_auto('${codelistJsonl.replace(/\\/g, '/')}',
                                    format='newline_delimited',
                                    maximum_object_size=16777216)
    ) TO '${codelistParquet.replace(/\\/g, '/')}' (FORMAT 'parquet', COMPRESSION 'zstd');
  `);
  await run(`
    COPY (
      SELECT * FROM read_json_auto('${itemJsonl.replace(/\\/g, '/')}',
                                    format='newline_delimited',
                                    maximum_object_size=16777216)
    ) TO '${itemParquet.replace(/\\/g, '/')}' (FORMAT 'parquet', COMPRESSION 'zstd');
  `);

  writeFileSync(
    resolve(PARQUET_DIR, 'manifest.json'),
    JSON.stringify(
      {
        source: 'CDISC Controlled Terminology (SDTM/CDASH union package)',
        ct_version: ctVersion,
        publisher: 'NCI Enterprise Vocabulary Services',
        publisher_url: 'https://evs.nci.nih.gov/ftp1/CDISC/SDTM/',
        license_terms_url:
          'https://www.cancer.gov/about-nci/organization/cbiit/vocabulary/cdisc',
        // The dashboard MUST surface this attribution wherever it renders
        // CT data — required by NCI's terms of use.
        attribution: ATTRIBUTION,
        fetched_at: new Date().toISOString(),
        codelist_count: codelists.length,
        item_count: items.length,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`Parsed ${codelists.length} codelists / ${items.length} items.`);
  console.log(`  → ${codelistParquet}`);
  console.log(`  → ${itemParquet}`);
  console.log(`  → CT version: ${ctVersion}`);
}

await fetchIfNeeded();
await emit(parse());