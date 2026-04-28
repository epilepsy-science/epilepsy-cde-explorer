import { computed, ref, watch } from 'vue';
import { useDuckDB } from '@/composables/useDuckDB';
import type { CrfItem, CrfRecord } from '@/types';

const STORAGE_KEY = 'cde-dashboard:crfs:v1';

interface CustomStorage {
  version: 1;
  crfs: CrfRecord[];
}

const seeded = ref<CrfRecord[]>([]);
const custom = ref<CrfRecord[]>([]);
const loaded = ref(false);
let loadingPromise: Promise<void> | null = null;

function readCustom(): CrfRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomStorage;
    if (parsed.version !== 1 || !Array.isArray(parsed.crfs)) return [];
    return parsed.crfs.map((c) => ({ registration_status: null, ...c, source: 'custom' }));
  } catch {
    return [];
  }
}

function writeCustom(list: CrfRecord[]) {
  const payload: CustomStorage = { version: 1, crfs: list };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

// DuckDB-WASM returns Arrow STRUCT[] columns as Vector objects that don't
// round-trip cleanly through toJSON(), so we cast items to a JSON string in
// SQL and parse it here.
function normalizeItems(raw: unknown): CrfItem[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((r: Record<string, unknown>) => ({
    type: String(r.type ?? 'cde') as CrfItem['type'],
    ref: r.ref == null ? null : String(r.ref),
    label: r.label == null ? null : String(r.label),
    instructions: r.instructions == null ? null : String(r.instructions),
  }));
}

async function loadSeeded(): Promise<CrfRecord[]> {
  const { query, ready } = useDuckDB();
  await ready();
  try {
    // Detect external_url column so we stay backwards-compatible with older
    // parquets that don't carry it.
    const cols = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'crf'`,
    );
    const hasExternalUrl = cols.some((c) => c.column_name === 'external_url');
    const externalUrlSelect = hasExternalUrl
      ? ', external_url'
      : ", CAST(NULL AS VARCHAR) AS external_url";
    const hasStudyType = cols.some((c) => c.column_name === '_study_type');
    const studyTypeSelect = hasStudyType
      ? ', _study_type AS study_type'
      : ", CAST(NULL AS VARCHAR) AS study_type";
    const hasRegistrationStatus = cols.some((c) => c.column_name === 'registration_status');
    const registrationStatusSelect = hasRegistrationStatus
      ? ', registration_status'
      : ", CAST(NULL AS VARCHAR) AS registration_status";
    const rows = await query<Record<string, unknown>>(
      `SELECT id, crf_name, title, description, instructions, version,
              disease_scope, estimated_duration_minutes, collection_frequency${externalUrlSelect}${studyTypeSelect}${registrationStatusSelect},
              CAST(items AS JSON) AS items
       FROM crf
       ORDER BY crf_name`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      crf_name: String(r.crf_name),
      title: String(r.title),
      description: (r.description as string | null) ?? null,
      instructions: (r.instructions as string | null) ?? null,
      version: String(r.version ?? '1.0'),
      disease_scope: (r.disease_scope as string | null) ?? null,
      estimated_duration_minutes:
        r.estimated_duration_minutes == null
          ? null
          : Number(r.estimated_duration_minutes),
      collection_frequency: (r.collection_frequency as string | null) ?? null,
      external_url: (r.external_url as string | null) ?? null,
      study_type: (r.study_type as 'Clinical' | 'Preclinical' | null) ?? null,
      registration_status: (r.registration_status as string | null) ?? null,
      items: normalizeItems(r.items),
      source: 'seeded',
    }));
  } catch {
    // No crf view registered (e.g. running against real discover data).
    return [];
  }
}

async function ensureLoaded(): Promise<void> {
  if (loaded.value) return;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      const [s] = await Promise.all([loadSeeded()]);
      seeded.value = s;
      custom.value = readCustom();
      loaded.value = true;
    })();
  }
  await loadingPromise;
}

const all = computed<CrfRecord[]>(() => [...seeded.value, ...custom.value]);

// Persist custom list whenever it changes.
watch(
  custom,
  (list) => {
    if (!loaded.value) return;
    writeCustom(list);
  },
  { deep: true },
);

function getCrf(id: string): CrfRecord | undefined {
  return all.value.find((c) => c.id === id);
}

function slugify(s: string): string {
  return s
    .trim()
    .replace(/[^\w\s-]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 64) || 'custom_crf';
}

function uniqueCrfName(base: string): string {
  const taken = new Set(all.value.map((c) => c.crf_name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 999; i++) {
    const cand = `${base}_${i}`;
    if (!taken.has(cand)) return cand;
  }
  return `${base}_${Date.now()}`;
}

function createCustomCrf(partial: {
  title: string;
  description?: string | null;
  disease_scope?: string | null;
}): CrfRecord {
  const now = new Date().toISOString();
  const title = partial.title.trim() || 'Untitled CRF';
  const rec: CrfRecord = {
    id: crypto.randomUUID(),
    crf_name: uniqueCrfName(slugify(title)),
    title,
    description: partial.description ?? null,
    instructions: null,
    version: '0.1',
    disease_scope: partial.disease_scope ?? null,
    estimated_duration_minutes: null,
    collection_frequency: null,
    external_url: null,
    study_type: null,
    registration_status: null,
    items: [],
    source: 'custom',
    created_at: now,
    updated_at: now,
  };
  custom.value = [...custom.value, rec];
  return rec;
}

/** Append an item to a custom CRF. Returns the updated record, or null if
 * the CRF is seeded (read-only) or not found. */
function addItemToCrf(
  crfId: string,
  item: { type: 'cde' | 'bundle' | 'section'; ref?: string | null; label?: string | null; instructions?: string | null },
): CrfRecord | null {
  const idx = custom.value.findIndex((c) => c.id === crfId);
  if (idx < 0) return null; // seeded or missing
  const c = custom.value[idx];
  const next: CrfRecord = {
    ...c,
    items: [...c.items, { ...item }],
    updated_at: new Date().toISOString(),
  };
  const list = [...custom.value];
  list[idx] = next;
  custom.value = list;
  return next;
}

function deleteCustomCrf(crfId: string): boolean {
  const before = custom.value.length;
  custom.value = custom.value.filter((c) => c.id !== crfId);
  return custom.value.length < before;
}

// ── Editing custom CRFs ─────────────────────────────────────────────────────
// Patch any of the metadata fields on a custom CRF. No-op for seeded CRFs
// (they're parquet-backed and read-only). Bumps updated_at.
type CrfPatch = Partial<
  Pick<
    CrfRecord,
    | 'title'
    | 'description'
    | 'instructions'
    | 'disease_scope'
    | 'study_type'
    | 'estimated_duration_minutes'
    | 'collection_frequency'
  >
>;

function updateCustomCrf(crfId: string, patch: CrfPatch): CrfRecord | null {
  const idx = custom.value.findIndex((c) => c.id === crfId);
  if (idx < 0) return null;
  const c = custom.value[idx];
  const next: CrfRecord = {
    ...c,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  const list = [...custom.value];
  list[idx] = next;
  custom.value = list;
  return next;
}

function removeItemFromCrf(crfId: string, itemIdx: number): CrfRecord | null {
  const idx = custom.value.findIndex((c) => c.id === crfId);
  if (idx < 0) return null;
  const c = custom.value[idx];
  if (itemIdx < 0 || itemIdx >= c.items.length) return c;
  const items = c.items.slice();
  items.splice(itemIdx, 1);
  const next: CrfRecord = { ...c, items, updated_at: new Date().toISOString() };
  const list = [...custom.value];
  list[idx] = next;
  custom.value = list;
  return next;
}

function reorderCrfItem(crfId: string, fromIdx: number, toIdx: number): CrfRecord | null {
  const idx = custom.value.findIndex((c) => c.id === crfId);
  if (idx < 0) return null;
  const c = custom.value[idx];
  if (
    fromIdx < 0 ||
    fromIdx >= c.items.length ||
    toIdx < 0 ||
    toIdx >= c.items.length ||
    fromIdx === toIdx
  ) {
    return c;
  }
  const items = c.items.slice();
  const [moved] = items.splice(fromIdx, 1);
  items.splice(toIdx, 0, moved);
  const next: CrfRecord = { ...c, items, updated_at: new Date().toISOString() };
  const list = [...custom.value];
  list[idx] = next;
  custom.value = list;
  return next;
}

export function useCrfStore() {
  return {
    loaded,
    ensureLoaded,
    crfs: all,
    seeded: computed(() => seeded.value),
    custom: computed(() => custom.value),
    getCrf,
    createCustomCrf,
    addItemToCrf,
    deleteCustomCrf,
    updateCustomCrf,
    removeItemFromCrf,
    reorderCrfItem,
  };
}
