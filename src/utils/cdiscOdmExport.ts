// Build a CDISC ODM-XML v2 metadata snapshot for a single CRF.
//
// ODM v2 hierarchy:
//   ItemDef  ──ItemRef──▶  ItemGroupDef  ──ItemGroupRef──▶  ItemGroupDef[Type="Form"]
//   (canonical)             (bundle)                         (form / CRF)
//
// Mapping:
//   our crf row             → outer <ItemGroupDef Type="Form">
//   our bundles             → inner <ItemGroupDef> referenced via <ItemGroupRef>
//   our standalone CDEs     → <ItemRef> on the outer form
//   our cde row             → <ItemDef> + <CodeList> when value-list
//   our cde_classification  → <ItemRef> attributes (Mandatory) + <Alias>
//
// ODM has no native disease-scope concept. We surface ours as
// <Alias Context="Pennsieve.disease.<scope>" Name="Y/N|tier"/> on each
// ItemDef — the same x-extension convention used by the JSON Schema exporter.
//
// Reference: https://wiki.cdisc.org/display/ODM2/

import { splitPipe, type CrfRecord } from '@/types';

export interface OdmCdeInput {
  cde_id: string;
  cde_name: string;
  variable_name: string | null;
  cde_data_type: string;
  cde_definition: string | null;
  preferred_question_text: string | null;
  unit_of_measure: string | null;
  pv_labels: string | null;
  pv_codes: string | null;
  pv_definitions: string | null;
  min_value: number | null;
  max_value: number | null;
  nlm_identifier: string | null;
  cde_origin: string | null;
  cdisc_domain: string | null;
  cdisc_variable_name: string | null;
  cdisc_variable_label: string | null;
  classification_agnostic: string | null;
  classification_neurotrauma: string | null;
  classification_tbi: string | null;
  classification_pte: string | null;
  classification_sci: string | null;
  classification_epilepsy: string | null;
}

export interface OdmBundleInput {
  bundle_name: string;
  description?: string | null;
  cdes: OdmCdeInput[];
}

// ── XML primitives ──────────────────────────────────────────────────────────

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Slugify any string into an ODM-OID-safe token. ODM allows letters,
 *  digits, and `_-:.` and caps at 128 chars; we limit to 120 to leave
 *  room for prefixes. */
function oidSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9_\-:.]/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 120);
  return cleaned || 'unnamed';
}

function uniqueOid(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}_${i}`)) i++;
  const oid = `${base}_${i}`;
  used.add(oid);
  return oid;
}

// ── Disease-scope helpers (mirrors jsonSchemaExport.ts) ─────────────────────

function diseaseKeyFromScope(scope: string | null | undefined): string | null {
  if (!scope) return null;
  const s = scope.trim().toLowerCase();
  const keys: Array<{ key: string; needles: string[] }> = [
    { key: 'pte', needles: ['post-traumatic epilepsy', 'pte'] },
    { key: 'tbi', needles: ['traumatic brain injury', 'tbi'] },
    { key: 'sci', needles: ['spinal cord injury', 'sci'] },
    { key: 'neurotrauma', needles: ['neurotrauma'] },
    { key: 'epilepsy', needles: ['epilepsy'] },
    { key: 'agnostic', needles: ['agnostic', 'disease-agnostic'] },
  ];
  for (const { key, needles } of keys) {
    if (needles.some((n) => s.includes(n))) return key;
  }
  return null;
}

const DISEASE_KEYS = ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci', 'epilepsy'] as const;
type DiseaseKey = (typeof DISEASE_KEYS)[number];

function classificationFor(cde: OdmCdeInput, key: DiseaseKey): string | null {
  return (cde[`classification_${key}` as keyof OdmCdeInput] as string | null) ?? null;
}

function effectiveTier(
  cde: OdmCdeInput,
  diseaseKey: string | null,
): 'Core' | 'Recommended' | 'Supplemental' | null {
  if (diseaseKey && (DISEASE_KEYS as readonly string[]).includes(diseaseKey)) {
    const v = classificationFor(cde, diseaseKey as DiseaseKey);
    if (v === 'Core' || v === 'Recommended' || v === 'Supplemental') return v;
    return null;
  }
  const tiers = DISEASE_KEYS.map((k) => classificationFor(cde, k));
  if (tiers.includes('Core')) return 'Core';
  if (tiers.includes('Recommended')) return 'Recommended';
  if (tiers.includes('Supplemental')) return 'Supplemental';
  return null;
}

// ── Type mapping ────────────────────────────────────────────────────────────

/** Map our cde_data_type enum to ODM v2's DataType attribute. ODM v2 accepts
 *  string, integer, float, double, decimal, boolean, date, time, datetime,
 *  partialDate, partialTime, partialDatetime, durationDatetime, intervalDatetime,
 *  incompleteDatetime, hexBinary, base64Binary, hexFloat, base64Float, URI. */
function mapOdmDataType(raw: string, hasNumericCodes: boolean): string {
  switch ((raw ?? '').toLowerCase()) {
    case 'number':
      return 'float';
    case 'value list':
      return hasNumericCodes ? 'integer' : 'string';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime':
      return 'datetime';
    case 'file/uri/url':
      return 'URI';
    case 'text':
    case 'other':
    case 'geolocation':
    default:
      return 'string';
  }
}

// ── Build ───────────────────────────────────────────────────────────────────

interface OdmBuildResult {
  xml: string;
  fieldCount: number;
  missingRefs: string[];
  diseaseKey: string | null;
}

export function buildOdmXml(
  crf: CrfRecord,
  cdesByRef: Map<string, OdmCdeInput>,
  bundlesByRef: Map<string, OdmBundleInput>,
  diseaseKeyOverride?: string | null,
): OdmBuildResult {
  const diseaseKey = diseaseKeyOverride ?? diseaseKeyFromScope(crf.disease_scope);
  const usedOids = new Set<string>();

  const formOid = uniqueOid(`FORM.${oidSlug(crf.crf_name)}`, usedOids);

  // Walk the CRF items in order, collecting:
  //   formChildren — alternating <ItemGroupRef> / <ItemRef> for the form's <ItemGroupDef>
  //   itemDefs     — <ItemDef> blocks (deduped by CDE)
  //   codeLists    — <CodeList> blocks (deduped by CDE since per-CDE)
  //   bundleDefs   — inner <ItemGroupDef> blocks (one per bundle)
  //   measureUnits — <MeasurementUnit> blocks (deduped by unit name)
  const formChildren: string[] = [];
  const itemDefs: string[] = [];
  const codeLists: string[] = [];
  const bundleDefs: string[] = [];
  const measureUnits = new Map<string, string>(); // oid → name
  const missingRefs: string[] = [];
  let order = 0;
  let fieldCount = 0;

  // Cache: cde content-key → assigned ItemOID. Same CDE referenced twice
  // (multiple bundles, or once standalone + once via a bundle) emits a
  // single ItemDef.
  const cdeOidCache = new Map<string, string>();
  const cdeUnitCache = new Map<string, string | null>(); // cdeKey → unit OID

  function resolveCde(cde: OdmCdeInput): { itemOid: string; unitOid: string | null } {
    const key =
      cde.variable_name?.replace(/^[A-Z0-9_-]+:/, '').trim() ||
      cde.cde_id ||
      cde.cde_name;
    if (cdeOidCache.has(key)) {
      return { itemOid: cdeOidCache.get(key)!, unitOid: cdeUnitCache.get(key) ?? null };
    }
    const baseOid = uniqueOid(`IT.${oidSlug(key)}`, usedOids);
    cdeOidCache.set(key, baseOid);

    // MeasurementUnit (one per distinct unit name across the form).
    let unitOid: string | null = null;
    if (cde.unit_of_measure) {
      unitOid = `MU.${oidSlug(cde.unit_of_measure)}`;
      if (!measureUnits.has(unitOid)) {
        measureUnits.set(unitOid, cde.unit_of_measure);
      }
    }
    cdeUnitCache.set(key, unitOid);

    // CodeList (per-CDE) + DataType resolution.
    const codes = splitPipe(cde.pv_codes);
    const labels = splitPipe(cde.pv_labels);
    const defs = splitPipe(cde.pv_definitions);
    const isValueList = (cde.cde_data_type ?? '').toLowerCase() === 'value list';
    const hasCodes = codes.length > 0 && codes.length === labels.length;
    const codeListSource = hasCodes ? codes : labels;
    const codeListLabels = labels.length === codeListSource.length ? labels : codeListSource;
    const codeListNumericCodes =
      hasCodes && codes.every((c) => /^-?\d+(\.\d+)?$/.test(c.trim()));

    const dataType = mapOdmDataType(cde.cde_data_type, codeListNumericCodes);
    let codeListOid: string | null = null;

    if (isValueList && codeListSource.length) {
      codeListOid = uniqueOid(`CL.${oidSlug(key)}`, usedOids);
      const items: string[] = [];
      for (let i = 0; i < codeListSource.length; i++) {
        const codedValue = codeListSource[i];
        const decode = codeListLabels[i] ?? codedValue;
        const def = defs[i];
        items.push(
          `        <CodeListItem CodedValue="${escapeAttr(codedValue)}">\n` +
            `          <Decode><TranslatedText xml:lang="en">${escapeText(decode)}</TranslatedText></Decode>` +
            (def
              ? `\n          <Description><TranslatedText xml:lang="en">${escapeText(def)}</TranslatedText></Description>`
              : '') +
            `\n        </CodeListItem>`,
        );
      }
      codeLists.push(
        `      <CodeList OID="${escapeAttr(codeListOid)}" Name="${escapeAttr(cde.cde_name)} value list" DataType="${dataType}">\n` +
          items.join('\n') +
          `\n      </CodeList>`,
      );
    }

    // ItemDef
    const lines: string[] = [];
    const attrs: string[] = [
      `OID="${escapeAttr(baseOid)}"`,
      `Name="${escapeAttr(cde.variable_name || cde.cde_name)}"`,
      `DataType="${dataType}"`,
    ];
    if (cde.variable_name) attrs.push(`SASFieldName="${escapeAttr(cde.variable_name.slice(0, 8))}"`);
    if (cde.cde_origin) attrs.push(`Origin="${escapeAttr(cde.cde_origin)}"`);
    lines.push(`      <ItemDef ${attrs.join(' ')}>`);
    if (cde.preferred_question_text) {
      lines.push(
        `        <Question><TranslatedText xml:lang="en">${escapeText(cde.preferred_question_text)}</TranslatedText></Question>`,
      );
    }
    if (cde.cde_definition) {
      lines.push(
        `        <Description><TranslatedText xml:lang="en">${escapeText(cde.cde_definition)}</TranslatedText></Description>`,
      );
    }
    if (cde.min_value != null || cde.max_value != null) {
      const checks: string[] = [];
      if (cde.min_value != null) {
        checks.push(
          `        <RangeCheck Comparator="GE" SoftHard="Soft"><CheckValue>${escapeText(String(cde.min_value))}</CheckValue></RangeCheck>`,
        );
      }
      if (cde.max_value != null) {
        checks.push(
          `        <RangeCheck Comparator="LE" SoftHard="Soft"><CheckValue>${escapeText(String(cde.max_value))}</CheckValue></RangeCheck>`,
        );
      }
      lines.push(...checks);
    }
    if (codeListOid) {
      lines.push(`        <CodeListRef CodeListOID="${escapeAttr(codeListOid)}"/>`);
    }
    if (unitOid) {
      lines.push(`        <MeasurementUnitRef MeasurementUnitOID="${escapeAttr(unitOid)}"/>`);
    }
    // Aliases — external identifiers + Pennsieve disease-scope extensions.
    if (cde.nlm_identifier) {
      lines.push(`        <Alias Context="NLM.CDE" Name="${escapeAttr(cde.nlm_identifier)}"/>`);
    }
    if (cde.cdisc_variable_name) {
      const cdiscName = cde.cdisc_domain
        ? `${cde.cdisc_domain}.${cde.cdisc_variable_name}`
        : cde.cdisc_variable_name;
      lines.push(`        <Alias Context="CDISC.CDASH" Name="${escapeAttr(cdiscName)}"/>`);
    }
    for (const k of DISEASE_KEYS) {
      const tier = classificationFor(cde, k);
      if (tier) {
        lines.push(
          `        <Alias Context="Pennsieve.disease.${k}" Name="${escapeAttr(tier)}"/>`,
        );
      }
    }
    lines.push(`      </ItemDef>`);
    itemDefs.push(lines.join('\n'));

    return { itemOid: baseOid, unitOid };
  }

  // Walk CRF items.
  for (const item of crf.items) {
    if (item.type === 'section') {
      // ODM has no inline section. Surface as a comment so the structure
      // is visible to readers without breaking schema validation.
      formChildren.push(
        `        <!-- Section: ${escapeText(item.label ?? '')} -->`,
      );
      continue;
    }
    if (item.type === 'cde' && item.ref) {
      const cde = cdesByRef.get(item.ref);
      if (!cde) {
        missingRefs.push(`cde:${item.ref}`);
        continue;
      }
      const { itemOid } = resolveCde(cde);
      order++;
      const tier = effectiveTier(cde, diseaseKey);
      formChildren.push(
        `        <ItemRef ItemOID="${escapeAttr(itemOid)}" OrderNumber="${order}" Mandatory="${tier === 'Core' ? 'Yes' : 'No'}"/>`,
      );
      fieldCount++;
      continue;
    }
    if (item.type === 'bundle' && item.ref) {
      const bundle = bundlesByRef.get(item.ref);
      if (!bundle) {
        missingRefs.push(`bundle:${item.ref}`);
        continue;
      }
      const bundleOid = uniqueOid(`IG.${oidSlug(bundle.bundle_name)}`, usedOids);
      order++;
      formChildren.push(
        `        <ItemGroupRef ItemGroupOID="${escapeAttr(bundleOid)}" OrderNumber="${order}" Mandatory="No"/>`,
      );

      // Inner ItemGroupDef for the bundle.
      const innerLines: string[] = [];
      innerLines.push(
        `      <ItemGroupDef OID="${escapeAttr(bundleOid)}" Name="${escapeAttr(bundle.bundle_name)}" Repeating="No">`,
      );
      if (bundle.description) {
        innerLines.push(
          `        <Description><TranslatedText xml:lang="en">${escapeText(bundle.description)}</TranslatedText></Description>`,
        );
      }
      let innerOrder = 0;
      for (const cde of bundle.cdes) {
        const { itemOid } = resolveCde(cde);
        innerOrder++;
        const tier = effectiveTier(cde, diseaseKey);
        innerLines.push(
          `        <ItemRef ItemOID="${escapeAttr(itemOid)}" OrderNumber="${innerOrder}" Mandatory="${tier === 'Core' ? 'Yes' : 'No'}"/>`,
        );
        fieldCount++;
      }
      innerLines.push(`      </ItemGroupDef>`);
      bundleDefs.push(innerLines.join('\n'));
    }
  }

  // ── Assemble the final document ──
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const fileOid = `pennsieve-${oidSlug(crf.crf_name)}-${now.replace(/[:.-]/g, '')}`;
  const studyOid = `Pennsieve.${oidSlug(crf.source ?? 'crf-review-dashboard')}`;

  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(
    `<ODM xmlns="http://www.cdisc.org/ns/odm/v2.0" ODMVersion="2.0" FileType="Snapshot" Granularity="Metadata" FileOID="${escapeAttr(fileOid)}" CreationDateTime="${now}">`,
  );
  out.push(`  <Study OID="${escapeAttr(studyOid)}">`);
  out.push(`    <GlobalVariables>`);
  out.push(`      <StudyName>${escapeText(crf.title)}</StudyName>`);
  out.push(
    `      <StudyDescription>${escapeText(crf.description || `${crf.title} — exported from Pennsieve CDE Review Dashboard`)}</StudyDescription>`,
  );
  out.push(`      <ProtocolName>${escapeText(crf.crf_name)}</ProtocolName>`);
  out.push(`    </GlobalVariables>`);
  out.push(
    `    <MetaDataVersion OID="MDV.1" Name="${escapeAttr(crf.title)} v${escapeAttr(crf.version)}">`,
  );

  // MeasurementUnits go first per the ODM v2 schema ordering.
  if (measureUnits.size) {
    out.push(`      <BasicDefinitions>`);
    for (const [oid, name] of measureUnits) {
      out.push(
        `        <MeasurementUnit OID="${escapeAttr(oid)}" Name="${escapeAttr(name)}"><Symbol><TranslatedText xml:lang="en">${escapeText(name)}</TranslatedText></Symbol></MeasurementUnit>`,
      );
    }
    out.push(`      </BasicDefinitions>`);
  }

  // Outer form ItemGroupDef.
  out.push(
    `      <ItemGroupDef OID="${escapeAttr(formOid)}" Name="${escapeAttr(crf.crf_name)}" Type="Form" Repeating="No">`,
  );
  if (crf.description) {
    out.push(
      `        <Description><TranslatedText xml:lang="en">${escapeText(crf.description)}</TranslatedText></Description>`,
    );
  }
  for (const child of formChildren) out.push(child);
  if (crf.disease_scope) {
    out.push(
      `        <Alias Context="Pennsieve.disease_scope" Name="${escapeAttr(crf.disease_scope)}"/>`,
    );
  }
  out.push(`      </ItemGroupDef>`);

  // Inner bundle ItemGroupDefs.
  for (const def of bundleDefs) out.push(def);

  // ItemDefs and CodeLists.
  for (const def of itemDefs) out.push(def);
  for (const cl of codeLists) out.push(cl);

  out.push(`    </MetaDataVersion>`);
  out.push(`  </Study>`);
  out.push(`</ODM>`);

  return {
    xml: out.join('\n') + '\n',
    fieldCount,
    missingRefs,
    diseaseKey,
  };
}

export function downloadOdmXml(crf: CrfRecord, xml: string) {
  const name = (crf.crf_name || crf.title).replace(/\s+/g, '_');
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}_odm.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
