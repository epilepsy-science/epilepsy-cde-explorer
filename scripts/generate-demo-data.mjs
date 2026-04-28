#!/usr/bin/env node
// Generates a clean, hand-curated preclinical neurotrauma demo dataset for the
// CDE Review Dashboard. Emits Pennsieve-format JSONL + relationships.csv into
// data/demo/, plus a schema.json per model.
//
// Scope: PTE + TBI focused (CCI injury model), with supporting SCI / Neurotrauma
// / Agnostic CDEs so the disease × domain heatmap and tier cards show realistic
// spread. Introduces a CRF model alongside CDE / Bundle / Classification.
//
// Usage: node scripts/generate-demo-data.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(ROOT, 'data/demo');

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Deterministic UUID-v5-ish from a string. */
function id(s) {
  const h = createHash('sha1').update(`cde-demo:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const TODAY = '2026-04-22';

/** Build a classification record from a compact spec.
 *
 * CDE-intrinsic fields (`minv`, `maxv`, `cdisc`, `origin`, `population`)
 * conceptually belong on the cde record, not on classification. Existing
 * call sites in this file pass them to `classif()` for terseness; we
 * accept and stash them on a private `_cde_intrinsic` key so the emit step
 * can merge them onto `def.data` instead. The classification record itself
 * never sees these fields. */
function classif({
  variable,
  core = [],
  rec = [],
  suppl = [],
  na = [],
  notes = null,
  version = 'Sample Preclinical v1.0',
  // CDE-intrinsic — collected here for ergonomic call sites, applied to
  // the cde record at emit time.
  minv,
  maxv,
  cdisc,
  origin,
  population,
}) {
  const diseases = ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'];
  const out = {
    variable_name: variable,
    version_name: version,
    version_date: '2026-04-01',
    notes,
    additional_instructions: null,
  };
  for (const d of diseases) {
    const y =
      core.includes(d) || rec.includes(d) || suppl.includes(d) || na.includes(d);
    out[`disease_${d}`] = y ? 'Y' : 'N';
    out[`classification_${d}`] = core.includes(d)
      ? 'Core'
      : rec.includes(d)
        ? 'Recommended'
        : suppl.includes(d)
          ? 'Supplemental'
          : na.includes(d)
            ? 'Not Applicable'
            : null;
  }
  const _cde_intrinsic = {};
  if (minv !== undefined) _cde_intrinsic.min_value = minv;
  if (maxv !== undefined) _cde_intrinsic.max_value = maxv;
  if (cdisc) {
    _cde_intrinsic.cdisc_domain = cdisc.domain ?? null;
    _cde_intrinsic.cdisc_variable_name = cdisc.var ?? null;
    _cde_intrinsic.cdisc_variable_label = cdisc.label ?? null;
  }
  if (origin) _cde_intrinsic.cde_origin = origin;
  if (population !== undefined) _cde_intrinsic.population = population;
  out._cde_intrinsic = _cde_intrinsic;
  return out;
}

/** Build a CDE data blob from a compact spec. CDE-intrinsic fields that
 *  used to live on classification (numeric range, cdisc_*, cde_origin,
 *  population) now sit here. */
function cde({
  name,
  aliases = null,
  dtype,
  definition,
  source = 'Sample Preclinical',
  stewardOrg = null,
  registrationStatus = null,
  question = null,
  keywords = null,
  unit = null,
  pvs = null, // Array<{ code?, label, def?, codeSystem?, conceptId?, conceptSource? }>
  refs = null,
  nlmId = null,
  decId = null,
  decSource = null,
  decName = null,
  cdeType = null,
  otherIds = null,
  minv = null,
  maxv = null,
  origin = 'COLLECTED',
  population = null,
  cdisc = null,
}) {
  let pv_labels = null,
    pv_codes = null,
    pv_definitions = null,
    pv_code_systems = null,
    pv_concept_identifiers = null,
    pv_terminology_sources = null;
  if (pvs && pvs.length) {
    pv_labels = pvs.map((p) => p.label).join('|');
    pv_codes = pvs.some((p) => p.code != null)
      ? pvs.map((p) => p.code ?? '').join('|')
      : null;
    pv_definitions = pvs.some((p) => p.def)
      ? pvs.map((p) => p.def ?? '').join('|')
      : null;
    pv_code_systems = pvs.some((p) => p.codeSystem)
      ? pvs.map((p) => p.codeSystem ?? '').join('|')
      : null;
    pv_concept_identifiers = pvs.some((p) => p.conceptId)
      ? pvs.map((p) => p.conceptId ?? '').join('|')
      : null;
    pv_terminology_sources = pvs.some((p) => p.conceptSource)
      ? pvs.map((p) => p.conceptSource ?? '').join('|')
      : null;
  }
  return {
    cde_name: name,
    aliases,
    cde_data_type: dtype,
    cde_definition: definition,
    cde_source: source,
    cde_type: cdeType,
    steward_org: stewardOrg,
    registration_status: registrationStatus,
    keywords,
    preferred_question_text: question,
    pv_codes,
    pv_labels,
    pv_definitions,
    pv_code_systems,
    pv_concept_identifiers,
    pv_terminology_sources,
    unit_of_measure: unit,
    min_value: minv,
    max_value: maxv,
    cde_origin: origin,
    population,
    cdisc_domain: cdisc?.domain ?? null,
    cdisc_variable_name: cdisc?.var ?? null,
    cdisc_variable_label: cdisc?.label ?? null,
    references: refs,
    nlm_identifier: nlmId,
    dec_identifier: decId,
    dec_terminology_source: decSource,
    dec_name: decName,
    other_identifiers: otherIds,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Enums used across CDEs
// ────────────────────────────────────────────────────────────────────────────

const ROUTE_PVS = [
  { code: 'IP', label: 'Intraperitoneal', def: 'Injection into the peritoneal cavity.' },
  { code: 'IV', label: 'Intravenous', def: 'Injection directly into a vein.' },
  { code: 'IM', label: 'Intramuscular', def: 'Injection into a muscle.' },
  { code: 'SC', label: 'Subcutaneous', def: 'Injection beneath the skin.' },
  { code: 'PO', label: 'Oral', def: 'Administration by mouth.' },
  { code: 'INH', label: 'Inhalation', def: 'Administration via inhaled vapor or gas.' },
];

const MASS_CONCENTRATION_PVS = [
  { code: 'MG_KG', label: 'mg/kg', def: 'Milligrams of drug per kilogram of body mass.' },
  { code: 'UG_KG', label: 'µg/kg', def: 'Micrograms of drug per kilogram of body mass.' },
  { code: 'MG', label: 'mg', def: 'Absolute dose in milligrams.' },
  { code: 'PCT', label: '% v/v', def: 'Volume-percent concentration (for inhaled agents).' },
];

const TIME_UNIT_PVS = [
  { code: 'D', label: 'Days', def: 'Duration measured in days.' },
  { code: 'WK', label: 'Weeks', def: 'Duration measured in weeks.' },
  { code: 'MO', label: 'Months', def: 'Duration measured in months.' },
  { code: 'YR', label: 'Years', def: 'Duration measured in years.' },
];

// ────────────────────────────────────────────────────────────────────────────
// CDE definitions
// ────────────────────────────────────────────────────────────────────────────

const CDES = {
  // ── Study metadata ───────────────────────────────────────────────────────
  Study_ID: {
    data: cde({
      name: 'Study ID',
      dtype: 'Text',
      definition: 'Unique identifier assigned to the study within the sponsoring institution.',
      question: 'What is the study identifier?',
      keywords: 'study, protocol, identifier',
    }),
    cls: classif({
      variable: 'SAMPLE:StudyID',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'TS', var: 'STUDYID', label: 'Study Identifier' },
    }),
    domain: 'Study Metadata',
    subdomain: 'Study Identification',
    category: 'Identifiers',
  },
  PI_Name: {
    data: cde({
      name: 'Principal Investigator Name',
      dtype: 'Text',
      definition: "Full name of the investigator primarily responsible for the study's scientific conduct.",
      question: 'Who is the principal investigator?',
    }),
    cls: classif({
      variable: 'SAMPLE:PIName',
      core: ['agnostic'],
      rec: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Study Metadata',
    subdomain: 'Study Identification',
    category: 'Personnel',
  },
  Study_Start_Date: {
    data: cde({
      name: 'Study Start Date',
      dtype: 'Date',
      definition: 'Date on which the approved study protocol was first activated for data collection.',
      question: 'On what date did the study begin?',
    }),
    cls: classif({
      variable: 'SAMPLE:StudyStartDate',
      core: ['agnostic'],
      rec: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Study Metadata',
    subdomain: 'Study Identification',
    category: 'Dates',
  },
  IACUC_Protocol_Number: {
    data: cde({
      name: 'IACUC Protocol Number',
      dtype: 'Text',
      definition: 'The Institutional Animal Care and Use Committee (IACUC) protocol number authorizing this study.',
      question: 'What is the IACUC protocol number?',
      keywords: 'ethics, animal welfare, approval',
    }),
    cls: classif({
      variable: 'SAMPLE:IACUCProtocolNumber',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Study Metadata',
    subdomain: 'Regulatory',
    category: 'Compliance',
  },

  // ── Subject metadata ─────────────────────────────────────────────────────
  Subject_ID: {
    data: cde({
      name: 'Subject ID',
      dtype: 'Text',
      definition: 'Unique identifier for an individual animal subject within the study.',
      question: 'What is the subject identifier?',
      keywords: 'animal, subject, identifier',
    }),
    cls: classif({
      variable: 'SAMPLE:SubjectID',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'DM', var: 'USUBJID', label: 'Unique Subject Identifier' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Subject Identification',
    category: 'Identifiers',
  },
  Sex: {
    data: cde({
      name: 'Sex',
      dtype: 'Value List',
      definition: 'Biological sex of the animal subject as identified at birth.',
      question: 'What is the sex of the subject?',
      pvs: [
        { code: 'M', label: 'Male', def: 'Male biological sex.' },
        { code: 'F', label: 'Female', def: 'Female biological sex.' },
        { code: 'U', label: 'Unknown', def: 'Biological sex not determined or not recorded.' },
      ],
    }),
    cls: classif({
      variable: 'SAMPLE:Sex',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'DM', var: 'SEX', label: 'Sex' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Demographics',
  },
  Species: {
    data: cde({
      name: 'Species',
      dtype: 'Value List',
      definition: 'Taxonomic species of the animal subject.',
      question: 'What species is the subject?',
      pvs: [
        { code: 'MUS', label: 'Mouse', def: 'Mus musculus (laboratory mouse).' },
        { code: 'RAT', label: 'Rat', def: 'Rattus norvegicus (laboratory rat).' },
        { code: 'FER', label: 'Ferret', def: 'Mustela putorius furo.' },
        { code: 'POR', label: 'Pig', def: 'Sus scrofa domesticus (domestic pig).' },
      ],
    }),
    cls: classif({
      variable: 'SAMPLE:Species',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'DM', var: 'SPECIES', label: 'Species' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Species & Strain',
  },
  Strain: {
    data: cde({
      name: 'Strain',
      dtype: 'Text',
      definition: 'Inbred or outbred strain designation for the subject, recorded using the standard nomenclature (e.g., C57BL/6J, Sprague-Dawley).',
      question: "What is the subject's strain?",
      keywords: 'strain, genetic background',
    }),
    cls: classif({
      variable: 'SAMPLE:Strain',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'DM', var: 'STRAIN', label: 'Strain' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Species & Strain',
  },
  Genotype: {
    data: cde({
      name: 'Genotype',
      dtype: 'Text',
      definition: 'Genotype of the subject, including any transgenes, knockouts, or reporter alleles. Use standard allele nomenclature.',
      question: "What is the subject's genotype?",
      keywords: 'genotype, transgene, knockout, reporter',
    }),
    cls: classif({
      variable: 'SAMPLE:Genotype',
      rec: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Species & Strain',
  },
  Date_Of_Birth: {
    data: cde({
      name: 'Date of Birth',
      dtype: 'Date',
      definition: 'Calendar date of the subject’s birth, or the known date of arrival if date of birth is unknown.',
      question: "What is the subject's date of birth?",
    }),
    cls: classif({
      variable: 'SAMPLE:DateOfBirth',
      rec: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'DM', var: 'BRTHDTC', label: 'Date/Time of Birth' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Dates',
  },

  // ── Age bundle ───────────────────────────────────────────────────────────
  Age_Value: {
    data: cde({
      name: 'Age Value',
      dtype: 'Number',
      definition: "Numeric value of the subject's age at the time of the event being recorded.",
      question: 'What is the age of the subject?',
      unit: null,
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:AgeValue',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      minv: 0,
      maxv: 1000,
      cdisc: { domain: 'DM', var: 'AGE', label: 'Age' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Age',
    bundle: 'Age',
  },
  Age_Unit: {
    data: cde({
      name: 'Age Unit',
      dtype: 'Value List',
      definition: "Unit of time in which the subject's age is expressed.",
      question: 'In what unit is the age recorded?',
      pvs: TIME_UNIT_PVS,
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:AgeUnit',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'DM', var: 'AGEU', label: 'Age Units' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Age',
    bundle: 'Age',
  },

  // ── Body weight bundle ───────────────────────────────────────────────────
  Body_Weight_Value: {
    data: cde({
      name: 'Body Weight Value',
      dtype: 'Number',
      definition: 'Measured body mass of the subject.',
      question: "What is the subject's body weight?",
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:BodyWeightValue',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      rec: ['agnostic'],
      minv: 0,
      maxv: 5000,
      cdisc: { domain: 'VS', var: 'VSORRES', label: 'Result or Finding (Weight)' },
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Body Weight',
    bundle: 'Body_Weight',
  },
  Body_Weight_Unit: {
    data: cde({
      name: 'Body Weight Unit',
      dtype: 'Value List',
      definition: 'Unit of mass in which body weight is expressed.',
      question: 'In what unit is the body weight recorded?',
      pvs: [
        { code: 'G', label: 'g', def: 'Grams.' },
        { code: 'KG', label: 'kg', def: 'Kilograms.' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:BodyWeightUnit',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      rec: ['agnostic'],
    }),
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Body Weight',
    bundle: 'Body_Weight',
  },

  // ── Injury model ─────────────────────────────────────────────────────────
  Injury_Model: {
    data: cde({
      name: 'Injury Model',
      dtype: 'Value List',
      definition: 'The preclinical injury model used to induce traumatic brain or spinal cord injury.',
      question: 'Which injury model was used?',
      pvs: [
        { code: 'CCI', label: 'Controlled Cortical Impact', def: 'Focal mechanical injury delivered by a computer-controlled impactor through a craniotomy.' },
        { code: 'FPI', label: 'Fluid Percussion Injury', def: 'Fluid pulse delivered to the intact dura through a craniotomy.' },
        { code: 'CHI', label: 'CHIMERA', def: 'Closed-Head Impact Model of Engineered Rotational Acceleration — non-surgical closed-head injury.' },
        { code: 'WD', label: 'Weight Drop', def: 'Closed- or open-head injury from a weight dropped along a guide tube.' },
        { code: 'SCC', label: 'Spinal Cord Contusion', def: 'Impactor-based focal contusion of the spinal cord.' },
        { code: 'SHAM', label: 'Sham', def: 'Surgical controls matched for anesthesia and craniotomy (or laminectomy) without injury delivery.' },
      ],
      refs: 'https://doi.org/10.1089/neu.2019.6400; https://doi.org/10.1038/nrn.2017.13',
    }),
    cls: classif({
      variable: 'SAMPLE:InjuryModel',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      na: ['agnostic'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Injury Model Selection',
  },
  Injury_Date: {
    data: cde({
      name: 'Injury Date',
      dtype: 'Date',
      definition: 'Calendar date on which the injury procedure was performed.',
      question: 'On what date was the injury performed?',
    }),
    cls: classif({
      variable: 'SAMPLE:InjuryDate',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      na: ['agnostic'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Dates',
  },
  Injury_Hemisphere: {
    data: cde({
      name: 'Injury Hemisphere',
      dtype: 'Value List',
      definition: 'Cerebral hemisphere on which the injury was delivered (for lateralized injury models).',
      question: 'On which hemisphere was the injury delivered?',
      pvs: [
        { code: 'L', label: 'Left', def: 'Left cerebral hemisphere.' },
        { code: 'R', label: 'Right', def: 'Right cerebral hemisphere.' },
        { code: 'B', label: 'Bilateral', def: 'Both hemispheres.' },
        { code: 'NA', label: 'Not Applicable', def: 'Injury model is not lateralized (e.g., closed-head or spinal cord injury).' },
      ],
    }),
    cls: classif({
      variable: 'SAMPLE:InjuryHemisphere',
      core: ['tbi', 'pte'],
      na: ['sci'],
      suppl: ['neurotrauma'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Injury Location',
  },

  // ── Impact velocity bundle ───────────────────────────────────────────────
  Impact_Velocity_Value: {
    data: cde({
      name: 'Impact Velocity Value',
      dtype: 'Number',
      definition: 'Linear velocity of the impactor tip at the moment of contact with the dural or cortical surface.',
      question: 'What was the impact velocity?',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:ImpactVelocityValue',
      core: ['tbi', 'pte'],
      suppl: ['neurotrauma'],
      minv: 0,
      maxv: 10,
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Impact Parameters',
    bundle: 'Impact_Velocity',
  },
  Impact_Velocity_Unit: {
    data: cde({
      name: 'Impact Velocity Unit',
      dtype: 'Value List',
      definition: 'Unit of speed in which impact velocity is expressed.',
      question: 'In what unit is the impact velocity recorded?',
      pvs: [
        { code: 'M_S', label: 'm/s', def: 'Meters per second.' },
        { code: 'MM_S', label: 'mm/s', def: 'Millimeters per second.' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:ImpactVelocityUnit',
      core: ['tbi', 'pte'],
      suppl: ['neurotrauma'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Impact Parameters',
    bundle: 'Impact_Velocity',
  },

  // ── Impact actuator bundle (enum + specify) ──────────────────────────────
  Impact_Actuator_Type: {
    data: cde({
      name: 'Impact Actuator Type',
      dtype: 'Value List',
      definition: 'The actuation mechanism used by the impactor to deliver the impact force.',
      question: 'Which type of impact actuator was used?',
      pvs: [
        { code: 'EM', label: 'Electromagnetic', def: 'Solenoid-driven impactor providing velocity-controlled contact.' },
        { code: 'PN', label: 'Pneumatic', def: 'Compressed-gas driven impactor.' },
        { code: 'SP', label: 'Spring-Loaded', def: 'Mechanical spring-driven impactor.' },
        { code: 'OTH', label: 'Other', def: 'Actuator mechanism not captured by the above; specify separately.' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:ImpactActuatorType',
      core: ['tbi'],
      rec: ['pte'],
      suppl: ['neurotrauma'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Impact Parameters',
    bundle: 'Impact_Actuator',
  },
  Impact_Actuator_Other: {
    data: cde({
      name: 'Impact Actuator Other (Specify)',
      dtype: 'Text',
      definition: 'Free-text specification of the impact actuator mechanism when "Other" is selected.',
      question: 'Specify the other impact actuator mechanism.',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:ImpactActuatorOther',
      suppl: ['tbi', 'pte', 'neurotrauma'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Impact Parameters',
    bundle: 'Impact_Actuator',
  },

  // ── Craniotomy coordinates bundle ────────────────────────────────────────
  Craniotomy_AP: {
    data: cde({
      name: 'Craniotomy AP Coordinate',
      dtype: 'Number',
      definition: 'Anterior-posterior coordinate of the craniotomy center relative to bregma, in millimeters. Positive values are anterior.',
      question: 'What was the AP coordinate of the craniotomy (mm from bregma)?',
      unit: 'mm',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:CraniotomyAP',
      core: ['tbi'],
      rec: ['pte'],
      minv: -10,
      maxv: 10,
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Surgical Procedure',
    category: 'Craniotomy',
    bundle: 'Craniotomy_Coordinates',
  },
  Craniotomy_ML: {
    data: cde({
      name: 'Craniotomy ML Coordinate',
      dtype: 'Number',
      definition: 'Medial-lateral coordinate of the craniotomy center relative to the midline, in millimeters. Report the magnitude; hemisphere is recorded separately.',
      question: 'What was the ML coordinate of the craniotomy (mm from midline)?',
      unit: 'mm',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:CraniotomyML',
      core: ['tbi'],
      rec: ['pte'],
      minv: 0,
      maxv: 10,
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Surgical Procedure',
    category: 'Craniotomy',
    bundle: 'Craniotomy_Coordinates',
  },
  Craniotomy_DV: {
    data: cde({
      name: 'Craniotomy DV Depth',
      dtype: 'Number',
      definition: 'Dorsal-ventral depth of the craniotomy from the cortical surface, in millimeters.',
      question: 'What was the depth of the craniotomy (mm)?',
      unit: 'mm',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:CraniotomyDV',
      core: ['tbi'],
      rec: ['pte'],
      minv: 0,
      maxv: 5,
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Surgical Procedure',
    category: 'Craniotomy',
    bundle: 'Craniotomy_Coordinates',
  },
  Craniotomy_Diameter: {
    data: cde({
      name: 'Craniotomy Diameter',
      dtype: 'Number',
      definition: 'Diameter of the craniotomy opening, in millimeters.',
      question: 'What was the diameter of the craniotomy (mm)?',
      unit: 'mm',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:CraniotomyDiameter',
      core: ['tbi'],
      rec: ['pte'],
      minv: 0,
      maxv: 20,
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Surgical Procedure',
    category: 'Craniotomy',
    bundle: 'Craniotomy_Coordinates',
  },

  // ── Anesthesia bundle ────────────────────────────────────────────────────
  Anesthesia_Agent: {
    data: cde({
      name: 'Anesthesia Agent',
      dtype: 'Value List',
      definition: 'Pharmacologic agent used to induce or maintain general anesthesia during the procedure.',
      question: 'Which anesthetic agent was used?',
      pvs: [
        { code: 'ISO', label: 'Isoflurane', def: 'Volatile halogenated ether anesthetic.' },
        { code: 'KX', label: 'Ketamine + Xylazine', def: 'Dissociative plus α2-agonist combination.' },
        { code: 'PEN', label: 'Pentobarbital', def: 'Barbiturate anesthetic.' },
        { code: 'AVE', label: 'Avertin (Tribromoethanol)', def: '2,2,2-tribromoethanol injectable anesthetic.' },
        { code: 'OTH', label: 'Other', def: 'Agent not captured above.' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:AnesthesiaAgent',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Anesthesia',
    category: 'Anesthesia Protocol',
    bundle: 'Anesthesia',
  },
  Anesthesia_Dose_Value: {
    data: cde({
      name: 'Anesthesia Dose Value',
      dtype: 'Number',
      definition: 'Numeric dose of the anesthetic agent administered, expressed in the unit recorded in the paired unit CDE.',
      question: 'What dose of the anesthetic agent was administered?',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:AnesthesiaDoseValue',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      minv: 0,
      maxv: 500,
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Anesthesia',
    category: 'Anesthesia Protocol',
    bundle: 'Anesthesia',
  },
  Anesthesia_Dose_Unit: {
    data: cde({
      name: 'Anesthesia Dose Unit',
      dtype: 'Value List',
      definition: 'Unit of measure for the anesthesia dose.',
      question: 'In what unit is the anesthesia dose recorded?',
      pvs: MASS_CONCENTRATION_PVS,
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:AnesthesiaDoseUnit',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Anesthesia',
    category: 'Anesthesia Protocol',
    bundle: 'Anesthesia',
  },
  Anesthesia_Route: {
    data: cde({
      name: 'Anesthesia Route',
      dtype: 'Value List',
      definition: 'Route by which the anesthetic agent was administered.',
      question: 'What was the route of administration for the anesthetic?',
      pvs: ROUTE_PVS,
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:AnesthesiaRoute',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Anesthesia',
    category: 'Anesthesia Protocol',
    bundle: 'Anesthesia',
  },

  // ── Drug administration bundle ───────────────────────────────────────────
  Drug_Name: {
    data: cde({
      name: 'Drug Name',
      dtype: 'Text',
      definition: 'Generic or systematic name of the administered investigational or comparator compound.',
      question: 'What drug was administered?',
      cdeType: 'Bundled Set of Questions',
      keywords: 'pharmacology, treatment',
    }),
    cls: classif({
      variable: 'SAMPLE:DrugName',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'EX', var: 'EXTRT', label: 'Name of Treatment' },
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Drug Administration',
    category: 'Treatment',
    bundle: 'Drug_Administration',
  },
  Drug_Dose_Value: {
    data: cde({
      name: 'Drug Dose Value',
      dtype: 'Number',
      definition: 'Numeric value of the administered drug dose.',
      question: 'What dose of the drug was administered?',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:DrugDoseValue',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      minv: 0,
      maxv: 1000,
      cdisc: { domain: 'EX', var: 'EXDOSE', label: 'Dose per Administration' },
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Drug Administration',
    category: 'Treatment',
    bundle: 'Drug_Administration',
  },
  Drug_Dose_Unit: {
    data: cde({
      name: 'Drug Dose Unit',
      dtype: 'Value List',
      definition: 'Unit of measure for the administered drug dose.',
      question: 'In what unit is the drug dose recorded?',
      pvs: MASS_CONCENTRATION_PVS,
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:DrugDoseUnit',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'EX', var: 'EXDOSU', label: 'Dose Units' },
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Drug Administration',
    category: 'Treatment',
    bundle: 'Drug_Administration',
  },
  Drug_Route: {
    data: cde({
      name: 'Drug Route',
      dtype: 'Value List',
      definition: 'Route by which the investigational drug was administered.',
      question: 'What was the route of administration?',
      pvs: ROUTE_PVS,
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:DrugRoute',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      cdisc: { domain: 'EX', var: 'EXROUTE', label: 'Route of Administration' },
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Drug Administration',
    category: 'Treatment',
    bundle: 'Drug_Administration',
  },

  // ── Body temperature bundle ──────────────────────────────────────────────
  Body_Temperature_Value: {
    data: cde({
      name: 'Body Temperature Value',
      dtype: 'Number',
      definition: "Measured body temperature of the subject at the time of recording.",
      question: "What is the subject's body temperature?",
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:BodyTemperatureValue',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
      minv: 30,
      maxv: 42,
    }),
    domain: 'Physiology',
    subdomain: 'Vital Signs',
    category: 'Body Temperature',
    bundle: 'Body_Temperature',
  },
  Body_Temperature_Unit: {
    data: cde({
      name: 'Body Temperature Unit',
      dtype: 'Value List',
      definition: 'Unit of temperature in which body temperature is expressed.',
      question: 'In what unit is the body temperature recorded?',
      pvs: [
        { code: 'C', label: '°C', def: 'Degrees Celsius.' },
        { code: 'F', label: '°F', def: 'Degrees Fahrenheit.' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:BodyTemperatureUnit',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Physiology',
    subdomain: 'Vital Signs',
    category: 'Body Temperature',
    bundle: 'Body_Temperature',
  },
  Body_Temperature_Method: {
    data: cde({
      name: 'Body Temperature Measurement Method',
      dtype: 'Value List',
      definition: 'Method by which body temperature was measured.',
      question: 'How was the body temperature measured?',
      pvs: [
        { code: 'REC', label: 'Rectal Probe', def: 'Temperature measured via a rectal thermistor or probe.' },
        { code: 'IR', label: 'Infrared', def: 'Non-contact infrared surface temperature measurement.' },
        { code: 'IMP', label: 'Implanted Transmitter', def: 'Temperature recorded from a surgically implanted biotelemetry device.' },
        { code: 'TYM', label: 'Tympanic', def: 'Tympanic membrane temperature measurement.' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:BodyTemperatureMethod',
      rec: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Physiology',
    subdomain: 'Vital Signs',
    category: 'Body Temperature',
    bundle: 'Body_Temperature',
  },

  // ── EEG sampling bundle ──────────────────────────────────────────────────
  Sampling_Rate_Value: {
    data: cde({
      name: 'EEG Sampling Rate Value',
      dtype: 'Number',
      definition: 'Sampling frequency at which the EEG signal was digitized.',
      question: 'What was the EEG sampling rate?',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:SamplingRateValue',
      core: ['pte'],
      rec: ['tbi'],
      minv: 1,
      maxv: 100000,
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Electrophysiology',
    category: 'EEG Acquisition',
    bundle: 'EEG_Sampling',
  },
  Sampling_Rate_Unit: {
    data: cde({
      name: 'EEG Sampling Rate Unit',
      dtype: 'Value List',
      definition: 'Unit in which the EEG sampling rate is expressed.',
      question: 'In what unit is the EEG sampling rate recorded?',
      pvs: [
        { code: 'HZ', label: 'Hz', def: 'Hertz (samples per second).' },
        { code: 'KHZ', label: 'kHz', def: 'Kilohertz (thousands of samples per second).' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:SamplingRateUnit',
      core: ['pte'],
      rec: ['tbi'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Electrophysiology',
    category: 'EEG Acquisition',
    bundle: 'EEG_Sampling',
  },

  // ── EEG standalones ──────────────────────────────────────────────────────
  EEG_Channel_Count: {
    data: cde({
      name: 'EEG Channel Count',
      dtype: 'Number',
      definition: 'Total number of EEG recording channels used in the session, excluding reference and ground electrodes.',
      question: 'How many EEG channels were recorded?',
      unit: 'count',
    }),
    cls: classif({
      variable: 'SAMPLE:EEGChannelCount',
      core: ['pte'],
      rec: ['tbi'],
      minv: 1,
      maxv: 256,
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Electrophysiology',
    category: 'EEG Acquisition',
  },
  EEG_Electrode_Type: {
    data: cde({
      name: 'EEG Electrode Type',
      dtype: 'Value List',
      definition: 'Physical form factor of the EEG electrodes used during recording.',
      question: 'What type of EEG electrodes was used?',
      pvs: [
        { code: 'SCR', label: 'Epidural Screw', def: 'Small screw electrode placed in the skull over the dura.' },
        { code: 'SUR', label: 'Surface', def: 'Electrode placed on the intact or reflected skin/skull surface.' },
        { code: 'DEP', label: 'Depth (Intracranial)', def: 'Wire electrode advanced into brain parenchyma.' },
        { code: 'WIRE', label: 'Subdural Wire', def: 'Flexible wire placed beneath the dura on the cortical surface.' },
      ],
    }),
    cls: classif({
      variable: 'SAMPLE:EEGElectrodeType',
      core: ['pte'],
      rec: ['tbi'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Electrophysiology',
    category: 'EEG Acquisition',
  },

  // ── Seizure onset timestamp bundle ───────────────────────────────────────
  Seizure_Onset_Date: {
    data: cde({
      name: 'Seizure Onset Date',
      dtype: 'Date',
      definition: 'Calendar date on which the seizure event was observed to begin.',
      question: 'On what date did the seizure begin?',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:SeizureOnsetDate',
      core: ['pte'],
      suppl: ['tbi'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Seizure Characterization',
    category: 'Seizure Event',
    bundle: 'Seizure_Onset',
  },
  Seizure_Onset_Time: {
    data: cde({
      name: 'Seizure Onset Time',
      dtype: 'Time',
      definition: 'Time of day at which the seizure event was observed to begin, in 24-hour format.',
      question: 'At what time did the seizure begin?',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:SeizureOnsetTime',
      core: ['pte'],
      suppl: ['tbi'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Seizure Characterization',
    category: 'Seizure Event',
    bundle: 'Seizure_Onset',
  },
  Seizure_Onset_Precision: {
    data: cde({
      name: 'Seizure Onset Precision',
      dtype: 'Value List',
      definition: 'Precision with which the seizure onset timestamp is known.',
      question: 'How precisely was the seizure onset time determined?',
      pvs: [
        { code: 'EXACT', label: 'Exact (EEG-verified)', def: 'Onset identified to within one second on the EEG record.' },
        { code: 'MIN', label: 'Within minute', def: 'Onset known to within one minute.' },
        { code: 'HR', label: 'Within hour', def: 'Onset known to within one hour.' },
        { code: 'EST', label: 'Estimated', def: 'Onset inferred from indirect evidence (cage check, video review).' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:SeizureOnsetPrecision',
      rec: ['pte'],
      suppl: ['tbi'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Seizure Characterization',
    category: 'Seizure Event',
    bundle: 'Seizure_Onset',
  },

  // ── Seizure standalones ──────────────────────────────────────────────────
  Seizure_Type: {
    data: cde({
      name: 'Seizure Type',
      dtype: 'Value List',
      definition: 'ILAE-aligned classification of the observed seizure semiology.',
      question: 'What type of seizure was observed?',
      pvs: [
        { code: 'FOC', label: 'Focal', def: 'Seizure arising from a localized region of one hemisphere.' },
        { code: 'FBTC', label: 'Focal to Bilateral Tonic-Clonic', def: 'Focal-onset seizure that evolves into bilateral tonic-clonic activity.' },
        { code: 'GTC', label: 'Generalized Tonic-Clonic', def: 'Generalized seizure with tonic stiffening followed by clonic jerking.' },
        { code: 'ABS', label: 'Absence', def: 'Brief behavioral arrest with generalized 3 Hz spike-and-wave on EEG.' },
        { code: 'MYO', label: 'Myoclonic', def: 'Brief involuntary muscle jerks without loss of awareness.' },
        { code: 'NCS', label: 'Non-Convulsive (Electrographic Only)', def: 'Seizure detected on EEG without overt behavioral manifestation.' },
        { code: 'UNK', label: 'Unknown', def: 'Insufficient information to classify.' },
      ],
      refs: 'https://doi.org/10.1111/epi.13671',
    }),
    cls: classif({
      variable: 'SAMPLE:SeizureType',
      core: ['pte'],
      suppl: ['tbi'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Seizure Characterization',
    category: 'Seizure Classification',
  },
  Racine_Score: {
    data: cde({
      name: 'Racine Behavioral Seizure Score',
      dtype: 'Value List',
      definition: 'Behavioral severity score for observed seizures, scaled 0-5 per the Racine (1972) classification.',
      question: 'What was the Racine score for the observed seizure?',
      pvs: [
        { code: '0', label: '0 - No response', def: 'No behavioral change.' },
        { code: '1', label: '1 - Facial clonus', def: 'Mouth and facial twitching.' },
        { code: '2', label: '2 - Head nodding', def: 'Rhythmic head movement.' },
        { code: '3', label: '3 - Forelimb clonus', def: 'Unilateral or bilateral forelimb clonus.' },
        { code: '4', label: '4 - Rearing', def: 'Rearing with forelimb clonus.' },
        { code: '5', label: '5 - Rearing and falling', def: 'Rearing, falling, generalized tonic-clonic activity.' },
      ],
      refs: 'https://doi.org/10.1016/0013-4694(72)90176-9',
      cdeType: 'Standalone',
    }),
    cls: classif({
      variable: 'SAMPLE:RacineScore',
      core: ['pte'],
      rec: ['tbi'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Seizure Characterization',
    category: 'Seizure Classification',
  },

  // ── Morris water maze bundle ─────────────────────────────────────────────
  MWM_Escape_Latency_Value: {
    data: cde({
      name: 'Morris Water Maze Escape Latency Value',
      dtype: 'Number',
      definition: 'Time from the start of a Morris Water Maze trial until the subject locates and mounts the hidden platform.',
      question: 'What was the escape latency for this trial?',
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:MWMEscapeLatencyValue',
      rec: ['tbi', 'pte', 'neurotrauma'],
      minv: 0,
      maxv: 120,
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Behavioral Assessment',
    category: 'Spatial Learning',
    bundle: 'MWM_Escape_Latency',
  },
  MWM_Escape_Latency_Unit: {
    data: cde({
      name: 'Morris Water Maze Escape Latency Unit',
      dtype: 'Value List',
      definition: 'Unit of time in which the Morris Water Maze escape latency is expressed.',
      question: 'In what unit is the escape latency recorded?',
      pvs: [
        { code: 'S', label: 's', def: 'Seconds.' },
        { code: 'MS', label: 'ms', def: 'Milliseconds.' },
      ],
      cdeType: 'Bundled Set of Questions',
    }),
    cls: classif({
      variable: 'SAMPLE:MWMEscapeLatencyUnit',
      rec: ['tbi', 'pte', 'neurotrauma'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Behavioral Assessment',
    category: 'Spatial Learning',
    bundle: 'MWM_Escape_Latency',
  },
  MWM_Trial_Number: {
    data: cde({
      name: 'Morris Water Maze Trial Number',
      dtype: 'Number',
      definition: 'Sequential trial number within the Morris Water Maze session for this subject.',
      question: 'What is the trial number?',
      unit: 'count',
    }),
    cls: classif({
      variable: 'SAMPLE:MWMTrialNumber',
      rec: ['tbi', 'pte', 'neurotrauma'],
      minv: 1,
      maxv: 40,
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Behavioral Assessment',
    category: 'Spatial Learning',
  },

  // ── Terminal tissue collection ───────────────────────────────────────────
  Euthanasia_Date: {
    data: cde({
      name: 'Euthanasia Date',
      dtype: 'Date',
      definition: 'Calendar date on which the subject was euthanized for tissue collection or at study termination.',
      question: 'On what date was the subject euthanized?',
    }),
    cls: classif({
      variable: 'SAMPLE:EuthanasiaDate',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Terminal Procedures',
    category: 'Euthanasia',
  },
  Euthanasia_Method: {
    data: cde({
      name: 'Euthanasia Method',
      dtype: 'Value List',
      definition: 'Method used to euthanize the subject, consistent with the applicable AVMA guidelines.',
      question: 'How was the subject euthanized?',
      pvs: [
        { code: 'CO2', label: 'CO₂ Inhalation', def: 'Gradual-fill carbon dioxide asphyxiation.' },
        { code: 'AOD', label: 'Anesthetic Overdose', def: 'Intraperitoneal barbiturate or equivalent overdose.' },
        { code: 'TCP', label: 'Transcardial Perfusion', def: 'Perfusion with fixative under deep anesthesia (for histology).' },
        { code: 'DEC', label: 'Decapitation', def: 'Decapitation under anesthesia, per IACUC approval.' },
        { code: 'CD', label: 'Cervical Dislocation', def: 'Cervical dislocation under anesthesia.' },
      ],
    }),
    cls: classif({
      variable: 'SAMPLE:EuthanasiaMethod',
      core: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Terminal Procedures',
    category: 'Euthanasia',
  },
  Tissue_Sample_ID: {
    data: cde({
      name: 'Tissue Sample ID',
      dtype: 'Text',
      definition: 'Unique identifier for a collected tissue sample (e.g., brain block, spinal cord segment, serum aliquot).',
      question: 'What is the tissue sample identifier?',
    }),
    cls: classif({
      variable: 'SAMPLE:TissueSampleID',
      rec: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Terminal Procedures',
    category: 'Sample Tracking',
  },
  Stain_Type: {
    data: cde({
      name: 'Histological Stain Type',
      dtype: 'Value List',
      definition: 'Staining protocol applied to the tissue section for histological analysis.',
      question: 'Which staining protocol was used?',
      pvs: [
        { code: 'HE', label: 'H&E', def: 'Hematoxylin and eosin.' },
        { code: 'CV', label: 'Cresyl Violet', def: 'Nissl stain for neuronal cell bodies.' },
        { code: 'FJ', label: 'Fluoro-Jade', def: 'Fluorescent marker for degenerating neurons.' },
        { code: 'NEUN', label: 'NeuN (IHC)', def: 'Immunohistochemistry for neuronal nuclei.' },
        { code: 'GFAP', label: 'GFAP (IHC)', def: 'Immunohistochemistry for astrocytes.' },
        { code: 'IBA1', label: 'Iba1 (IHC)', def: 'Immunohistochemistry for microglia.' },
      ],
    }),
    cls: classif({
      variable: 'SAMPLE:StainType',
      rec: ['neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Histology',
    category: 'Tissue Analysis',
  },

  // ── Generic event date (reused across CRFs) ──────────────────────────────
  Observation_Date: {
    data: cde({
      name: 'Observation Date',
      dtype: 'Date',
      definition: 'Calendar date on which a scheduled observation or assessment was conducted.',
      question: 'On what date was the observation made?',
    }),
    cls: classif({
      variable: 'SAMPLE:ObservationDate',
      core: ['agnostic', 'neurotrauma', 'tbi', 'pte', 'sci'],
    }),
    domain: 'Study Metadata',
    subdomain: 'Visits',
    category: 'Dates',
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Bundle definitions (metadata — CDE membership is derived from `bundle` field)
// ────────────────────────────────────────────────────────────────────────────

const BUNDLES = {
  Age: {
    display: 'Age',
    description: 'Numeric age together with its unit of measure. Neither is interpretable alone.',
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Age',
    working_group: 'Subject Characterization',
    disease_scope: 'Agnostic',
    source: 'Sample Preclinical',
  },
  Body_Weight: {
    display: 'Body Weight',
    description: "Measured body mass together with its unit of measure.",
    domain: 'Subject Metadata',
    subdomain: 'Demographics',
    category: 'Body Weight',
    working_group: 'Subject Characterization',
    disease_scope: 'Agnostic',
    source: 'Sample Preclinical',
  },
  Impact_Velocity: {
    display: 'Impact Velocity',
    description: 'Linear velocity of the impactor at contact, with its unit. Required for reproducibility of focal TBI models.',
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Impact Parameters',
    working_group: 'TBI/PTE Injury',
    disease_scope: 'TBI/PTE',
    source: 'PRECISE-TBI; Sample Preclinical',
  },
  Impact_Actuator: {
    display: 'Impact Actuator',
    description: 'The mechanism used to deliver the impact, with a free-text "Other" specification when applicable.',
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Injury Models',
    category: 'Impact Parameters',
    working_group: 'TBI/PTE Injury',
    disease_scope: 'TBI/PTE',
    source: 'PRECISE-TBI; Sample Preclinical',
  },
  Craniotomy_Coordinates: {
    display: 'Craniotomy Coordinates',
    description: 'Stereotaxic location and size of the craniotomy (AP, ML, DV, diameter). Coordinates are only meaningful as a complete set.',
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Surgical Procedure',
    category: 'Craniotomy',
    working_group: 'TBI/PTE Injury',
    disease_scope: 'TBI/PTE',
    source: 'Sample Preclinical',
  },
  Anesthesia: {
    display: 'Anesthesia Protocol',
    description: 'Anesthetic agent, dose (value + unit), and route of administration.',
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Anesthesia',
    category: 'Anesthesia Protocol',
    working_group: 'Neurotrauma',
    disease_scope: 'Neurotrauma',
    source: 'Sample Preclinical',
  },
  Drug_Administration: {
    display: 'Drug Administration',
    description: 'Investigational drug name, dose (value + unit), and route. Captures a single administration event.',
    domain: 'Procedures and Experimental Parameters',
    subdomain: 'Drug Administration',
    category: 'Treatment',
    working_group: 'Neurotrauma',
    disease_scope: 'Neurotrauma',
    source: 'Sample Preclinical',
  },
  Body_Temperature: {
    display: 'Body Temperature Measurement',
    description: 'Body temperature value with its unit and the method by which it was measured.',
    domain: 'Physiology',
    subdomain: 'Vital Signs',
    category: 'Body Temperature',
    working_group: 'Neurotrauma',
    disease_scope: 'Neurotrauma',
    source: 'Sample Preclinical',
  },
  EEG_Sampling: {
    display: 'EEG Sampling Configuration',
    description: 'Digitization rate of the EEG signal, with its unit.',
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Electrophysiology',
    category: 'EEG Acquisition',
    working_group: 'PTE',
    disease_scope: 'PTE',
    source: 'Sample Preclinical',
  },
  Seizure_Onset: {
    display: 'Seizure Onset Timestamp',
    description: 'Date and time of seizure onset together with the precision of that timestamp.',
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Seizure Characterization',
    category: 'Seizure Event',
    working_group: 'PTE',
    disease_scope: 'PTE',
    source: 'Sample Preclinical',
  },
  MWM_Escape_Latency: {
    display: 'Morris Water Maze Escape Latency',
    description: 'Trial escape latency value with its unit.',
    domain: 'Assessments, Assays and Outcomes',
    subdomain: 'Behavioral Assessment',
    category: 'Spatial Learning',
    working_group: 'Neurotrauma',
    disease_scope: 'Neurotrauma',
    source: 'Sample Preclinical',
  },
};

// ────────────────────────────────────────────────────────────────────────────
// CRF definitions
// ────────────────────────────────────────────────────────────────────────────

const CRFS = [
  {
    name: 'Study_Enrollment_Form',
    title: 'Study Enrollment Form',
    version: '1.0',
    disease_scope: 'TBI/PTE/SCI',
    estimated_duration_minutes: 10,
    collection_frequency: 'Once per subject',
    description: 'Baseline characterization of each animal subject at the time of study enrollment.',
    instructions:
      '## When to complete\nComplete this form **once per subject**, on the day the animal enters the study and before any injury procedure.\n\n## Required items\nAll Core items must be completed. Strain and Genotype are important whenever a transgenic line is used.\n\n## Notes\nSubject ID must be unique across the entire study and immutable once assigned.',
    items: [
      { type: 'section', label: 'Subject Identification', instructions: null },
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'cde', ref: 'Sex' },
      { type: 'cde', ref: 'Species' },
      { type: 'cde', ref: 'Strain' },
      { type: 'cde', ref: 'Genotype' },
      { type: 'cde', ref: 'Date_Of_Birth' },
      { type: 'section', label: 'Baseline Measurements', instructions: 'Record age and body weight at enrollment.' },
      { type: 'bundle', ref: 'Age' },
      { type: 'bundle', ref: 'Body_Weight' },
      { type: 'section', label: 'Study Context' },
      { type: 'cde', ref: 'Study_ID' },
      { type: 'cde', ref: 'IACUC_Protocol_Number' },
    ],
  },
  {
    name: 'CCI_Injury_Procedure_Form',
    title: 'Controlled Cortical Impact (CCI) Injury Procedure Form',
    version: '1.0',
    disease_scope: 'TBI/PTE',
    estimated_duration_minutes: 20,
    collection_frequency: 'Once per subject at injury',
    description: 'Complete record of the surgical procedure and impact parameters for a CCI injury or sham control.',
    instructions:
      '## When to complete\nComplete **immediately following** the injury procedure while the animal is recovering.\n\n## Required items\nAll impact parameters (velocity, actuator, craniotomy coordinates) must be recorded. Body temperature is recorded at the start and end of the procedure using this form twice if needed.\n\n## Sham controls\nFor Sham subjects, complete the craniotomy coordinates section but leave Impact Velocity and Impact Actuator empty.',
    items: [
      { type: 'section', label: 'Identifiers' },
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'cde', ref: 'Injury_Date' },
      { type: 'cde', ref: 'Injury_Model' },
      { type: 'cde', ref: 'Injury_Hemisphere' },
      { type: 'section', label: 'Anesthesia', instructions: 'Record the agent used to induce and maintain anesthesia during the procedure.' },
      { type: 'bundle', ref: 'Anesthesia' },
      { type: 'bundle', ref: 'Body_Temperature' },
      { type: 'section', label: 'Surgical Procedure', instructions: 'Stereotaxic craniotomy location relative to bregma.' },
      { type: 'bundle', ref: 'Craniotomy_Coordinates' },
      { type: 'section', label: 'Impact Parameters', instructions: 'Complete for CCI and Weight Drop injuries; leave blank for Sham.' },
      { type: 'bundle', ref: 'Impact_Velocity' },
      { type: 'bundle', ref: 'Impact_Actuator' },
    ],
  },
  {
    name: 'Post_Injury_Monitoring_Log',
    title: 'Post-Injury Daily Monitoring Log',
    version: '1.0',
    disease_scope: 'TBI/PTE/SCI',
    estimated_duration_minutes: 5,
    collection_frequency: 'Daily for 7 days post-injury',
    description: 'Daily welfare monitoring log for the acute post-injury period.',
    instructions:
      '## When to complete\nComplete **once daily** for the first 7 days following injury. Thereafter, weekly for the remainder of the study.\n\n## Priority observations\nAny Racine score ≥ 3 or an unexplained ≥15% drop in body weight should trigger an additional Seizure Event Form or veterinary review.',
    items: [
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'cde', ref: 'Observation_Date' },
      { type: 'section', label: 'Vital Signs' },
      { type: 'bundle', ref: 'Body_Weight' },
      { type: 'bundle', ref: 'Body_Temperature' },
      { type: 'section', label: 'Observed Seizure Activity', instructions: 'If any seizure activity is observed, also complete a dedicated Seizure Event Form.' },
      { type: 'cde', ref: 'Seizure_Type' },
      { type: 'cde', ref: 'Racine_Score' },
    ],
  },
  {
    name: 'EEG_Recording_Session_Form',
    title: 'EEG Recording Session Form',
    version: '1.0',
    disease_scope: 'PTE',
    estimated_duration_minutes: 8,
    collection_frequency: 'Per recording session',
    description: 'Session-level metadata and acquisition parameters for continuous or event-triggered EEG recording.',
    instructions:
      '## When to complete\nComplete **at the start of each recording session**, before initiating data acquisition.\n\n## Electrode placement\nIf electrode coordinates changed from a prior session (e.g., after re-implantation), annotate this in the notes field on the subject chart.',
    items: [
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'cde', ref: 'Observation_Date' },
      { type: 'section', label: 'Acquisition Configuration' },
      { type: 'bundle', ref: 'EEG_Sampling' },
      { type: 'cde', ref: 'EEG_Channel_Count' },
      { type: 'cde', ref: 'EEG_Electrode_Type' },
    ],
  },
  {
    name: 'Seizure_Event_Form',
    title: 'Seizure Event Form',
    version: '1.0',
    disease_scope: 'PTE',
    estimated_duration_minutes: 5,
    collection_frequency: 'Per seizure event',
    description: 'Per-event characterization of spontaneous recurrent seizures.',
    instructions:
      '## When to complete\nComplete **for each individual seizure event**. For behavioral events, complete as soon as practical after observation; for EEG-detected events, complete during post-hoc review.\n\n## Onset precision\nChoose the most precise category that you can defend from the available evidence. When in doubt, use the broader category.',
    items: [
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'bundle', ref: 'Seizure_Onset' },
      { type: 'section', label: 'Semiology' },
      { type: 'cde', ref: 'Seizure_Type' },
      { type: 'cde', ref: 'Racine_Score' },
    ],
  },
  {
    name: 'Morris_Water_Maze_Session_Form',
    title: 'Morris Water Maze Session Form',
    version: '1.0',
    disease_scope: 'TBI/PTE',
    estimated_duration_minutes: 15,
    collection_frequency: 'Per behavioral session',
    description: 'Trial-level record for Morris Water Maze spatial learning assessment.',
    instructions:
      '## When to complete\nOne row per trial; complete immediately after each trial. Typical protocol is 4 trials per day for 5 consecutive days, followed by a probe trial on day 6.\n\n## Cutoff\nAny trial in which the animal has not located the platform by 60 seconds is guided to the platform and the latency is recorded as 60 seconds.',
    items: [
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'cde', ref: 'Observation_Date' },
      { type: 'cde', ref: 'MWM_Trial_Number' },
      { type: 'bundle', ref: 'MWM_Escape_Latency' },
    ],
  },
  {
    name: 'Drug_Administration_Form',
    title: 'Drug Administration Form',
    version: '1.0',
    disease_scope: 'TBI/PTE/SCI',
    estimated_duration_minutes: 3,
    collection_frequency: 'Per administration',
    description: 'Record of each investigational or comparator drug administration.',
    instructions:
      '## When to complete\nComplete **each time** an investigational or comparator compound is administered, including vehicle controls.\n\n## Vehicle administrations\nFor vehicle, enter the vehicle composition as the Drug Name (e.g., "0.9% Saline", "DMSO 10% in PBS").',
    items: [
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'cde', ref: 'Observation_Date' },
      { type: 'bundle', ref: 'Drug_Administration' },
    ],
  },
  {
    name: 'Terminal_Tissue_Collection_Form',
    title: 'Terminal Tissue Collection Form',
    version: '1.0',
    disease_scope: 'TBI/PTE/SCI',
    estimated_duration_minutes: 15,
    collection_frequency: 'Once per subject at euthanasia',
    description: 'End-of-study euthanasia and tissue collection record.',
    instructions:
      '## When to complete\nComplete **at the time of euthanasia and tissue harvest**.\n\n## Sample identifiers\nEnter one Tissue Sample ID row for each distinct sample collected (e.g., left hemisphere, right hemisphere, spinal cord, serum aliquot). Ensure each ID is unique within the study.',
    items: [
      { type: 'cde', ref: 'Subject_ID' },
      { type: 'cde', ref: 'Euthanasia_Date' },
      { type: 'cde', ref: 'Euthanasia_Method' },
      { type: 'section', label: 'Tissue Samples', instructions: 'One entry per collected sample.' },
      { type: 'cde', ref: 'Tissue_Sample_ID' },
      { type: 'cde', ref: 'Stain_Type' },
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// Provenance
// ────────────────────────────────────────────────────────────────────────────

// Provenance has been slimmed: only fields the dashboard actually reads
// remain. The previous 13 metadata fields (workgroup, extraction_date,
// file_*, sheet_name, folder_path, format_tier, etl_version, cde_count,
// bundle_count, classification_count, review_count, notes) were never
// rendered or queried, so they're omitted across all extractors now.
const PROVENANCE = [
  {
    source_key: 'sample-preclinical-cdes-v1',
    label: 'Sample Preclinical CDEs',
    study_type: 'Preclinical',
    // 'sample' = illustrative training dataset; reviewers are warned that
    // their feedback won't roll up to a published curation. 'production'
    // sources are real catalog efforts (NINDS, NLM, PTE-Clinical, etc.).
    kind: 'sample',
  },
];

// ────────────────────────────────────────────────────────────────────────────
// JSON Schemas (mirror the Pennsieve schema format)
// ────────────────────────────────────────────────────────────────────────────

const SCHEMAS = {
  cde: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['cde_name', 'cde_data_type', 'cde_definition', 'cde_source'],
    properties: {}, // (shape matches the original, dashboard doesn't require this file)
  },
  cde_classification: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['variable_name'],
    properties: {},
  },
  bundle: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['bundle_name', 'domain', 'subdomain', 'category', 'working_group'],
    properties: {},
  },
  provenance: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['source_key', 'label', 'workgroup', 'extraction_date'],
    properties: {},
  },
  crf: {
    type: 'object',
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['crf_name', 'title', 'version', 'items'],
    properties: {
      crf_name: { type: 'string', 'x-pennsieve-key': true },
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      instructions: { type: ['string', 'null'], description: 'Markdown-formatted instructions for data collectors.' },
      version: { type: 'string' },
      disease_scope: { type: 'string' },
      estimated_duration_minutes: { type: ['integer', 'null'] },
      collection_frequency: { type: ['string', 'null'] },
      external_url: {
        type: ['string', 'null'],
        description: 'Canonical URL to the official form document (e.g. DOCX/PDF hosted by the source organization).',
      },
      items: {
        type: 'array',
        description: 'Ordered list of form items. Each is a section header, a bundle reference, or a CDE reference.',
      },
    },
  },
};

// ────────────────────────────────────────────────────────────────────────────
// Emit
// ────────────────────────────────────────────────────────────────────────────

function writeJsonl(modelName, records, schema) {
  const dir = resolve(OUT, `metadata/models/${modelName}/versions/1`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, 'records.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  writeFileSync(resolve(dir, 'schema.json'), JSON.stringify(schema, null, 2));
}

function main() {
  mkdirSync(resolve(OUT, 'metadata'), { recursive: true });

  // CDE records — merge any CDE-intrinsic overrides that call sites stashed
  // on `def.cls._cde_intrinsic` (numeric range, cdisc_*, cde_origin, etc.).
  const cdeRecords = Object.entries(CDES).map(([key, def]) => {
    const intrinsic = def.cls?._cde_intrinsic ?? {};
    return {
      id: id(`cde/${key}`),
      data: { ...def.data, ...intrinsic },
    };
  });

  // Classification records — also carry the CDE's own domain/subdomain/category
  // so unbundled CDEs can be placed in the taxonomy too (bundles don't own the
  // taxonomy; they just group CDEs that share some of it). Strip the
  // `_cde_intrinsic` private key before emitting.
  const classificationRecords = Object.entries(CDES).map(([key, def]) => {
    const { _cde_intrinsic: _, ...clsClean } = def.cls;
    return {
      id: id(`cls/${key}`),
      data: {
        ...clsClean,
        domain: def.domain ?? null,
        subdomain: def.subdomain ?? null,
        category: def.category ?? null,
      },
    };
  });

  // Bundle records — `disease_scope` and `source` were defined here but
  // never read by the dashboard or extractors, so they're omitted now.
  const bundleRecords = Object.entries(BUNDLES).map(([key, def]) => ({
    id: id(`bundle/${key}`),
    data: {
      bundle_name: def.display,
      description: def.description,
      display_name: def.display,
      domain: def.domain,
      subdomain: def.subdomain,
      category: def.category,
      working_group: def.working_group,
    },
  }));

  // CRF records
  // CRF item refs are JS object keys (e.g. Subject_ID, Body_Weight). Translate
  // to the canonical cde_name / bundle_name that consumers will see in the
  // emitted records. Fail loudly on dangling refs — bad demo data is worse
  // than a generator error.
  const resolveItemRef = (it) => {
    if (it.type === 'cde') {
      const c = CDES[it.ref];
      if (!c) throw new Error(`CRF references unknown CDE: ${it.ref}`);
      return { ...it, ref: c.data.cde_name };
    }
    if (it.type === 'bundle') {
      const b = BUNDLES[it.ref];
      if (!b) throw new Error(`CRF references unknown Bundle: ${it.ref}`);
      return { ...it, ref: b.display };
    }
    return it;
  };
  const crfRecords = CRFS.map((crf) => ({
    id: id(`crf/${crf.name}`),
    data: {
      crf_name: crf.name,
      title: crf.title,
      description: crf.description,
      instructions: crf.instructions,
      version: crf.version,
      disease_scope: crf.disease_scope,
      estimated_duration_minutes: crf.estimated_duration_minutes,
      collection_frequency: crf.collection_frequency,
      external_url: crf.external_url ?? null,
      items: crf.items.map(resolveItemRef),
    },
  }));

  // Provenance records
  const provenanceRecords = PROVENANCE.map((p) => ({
    id: id(`prov/${p.source_key}`),
    data: p,
  }));

  // Relationships:
  //   classification -[CLASSIFIES]-> cde
  //   classification -[PART_OF]-> bundle   (only when the CDE is in a bundle)
  //   cde            -[SOURCED_FROM]-> provenance
  //   bundle         -[SOURCED_FROM]-> provenance
  //   classification -[SOURCED_FROM]-> provenance
  const rels = [];
  const provId = id(`prov/${PROVENANCE[0].source_key}`);
  for (const key of Object.keys(CDES)) {
    const cdeId = id(`cde/${key}`);
    const clsId = id(`cls/${key}`);
    rels.push({ source_id: clsId, target_id: cdeId, type: 'CLASSIFIES' });
    const bundleKey = CDES[key].bundle;
    if (bundleKey) {
      const bundleId = id(`bundle/${bundleKey}`);
      rels.push({ source_id: clsId, target_id: bundleId, type: 'PART_OF' });
    }
    rels.push({ source_id: cdeId, target_id: provId, type: 'SOURCED_FROM' });
    rels.push({ source_id: clsId, target_id: provId, type: 'SOURCED_FROM' });
  }
  for (const bk of Object.keys(BUNDLES)) {
    rels.push({
      source_id: id(`bundle/${bk}`),
      target_id: provId,
      type: 'SOURCED_FROM',
    });
  }

  // Write all records
  writeJsonl('cde', cdeRecords, SCHEMAS.cde);
  writeJsonl('cde_classification', classificationRecords, SCHEMAS.cde_classification);
  writeJsonl('bundle', bundleRecords, SCHEMAS.bundle);
  writeJsonl('crf', crfRecords, SCHEMAS.crf);
  writeJsonl('provenance', provenanceRecords, SCHEMAS.provenance);

  // Relationships CSV
  const csv = [
    'source_record_id,target_record_id,relationship_type',
    ...rels.map((r) => `${r.source_id},${r.target_id},${r.type}`),
  ].join('\n');
  writeFileSync(resolve(OUT, 'metadata/relationships.csv'), csv + '\n');

  // files.csv (dashboard doesn't use this, but keeps parity with Pennsieve layout)
  writeFileSync(resolve(OUT, 'metadata/files.csv'), 'name,path,size,fileType\n');

  // Manifest (minimal)
  const manifest = {
    name: 'Sample Preclinical CDE Set',
    description:
      'Hand-curated preclinical neurotrauma demo CDEs, Bundles, and CRFs for the CDE Review Dashboard.',
    version: 1,
    datePublished: TODAY,
    pennsieveSchemaVersion: '5.0',
  };
  writeFileSync(resolve(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log(`Wrote demo data to ${OUT}`);
  console.log(`  CDE:             ${cdeRecords.length}`);
  console.log(`  Classifications: ${classificationRecords.length}`);
  console.log(`  Bundles:         ${bundleRecords.length}`);
  console.log(`  CRFs:            ${crfRecords.length}`);
  console.log(`  Provenance:      ${provenanceRecords.length}`);
  console.log(`  Relationships:   ${rels.length}`);
}

main();
