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
    return parsed.crfs.map((c) => ({
      ...c,
      registration_status: c.registration_status ?? null,
      source: 'custom' as const,
    }));
  } catch {
    return [];
  }
}

function writeCustom(list: CrfRecord[]) {
  const payload: CustomStorage = { version: 1, crfs: list };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

async function loadSeeded(): Promise<CrfRecord[]> {
  const { query, ready } = useDuckDB();
  await ready();
  try {
    // Catalog CRFs are the published `form` model (a NINDS CRF / NLM non-bundle
    // form is a CRF — see cde-service form.schema). Members come from the ordered
    // `member_cde_keys` (which are cde_keys == cde_canonical.cde_id); translate
    // them to cde_name refs so CrfDetailView resolves them exactly like the items
    // of a custom CRF (which also ref by cde_name).
    const forms = await query<{
      id: string;
      form_key: string;
      form_name: string;
      member_cde_keys: string | null;
    }>(
      `SELECT id, form_key, form_name, member_cde_keys FROM form ORDER BY form_name`,
    );
    if (!forms.length) return [];

    // One pass: cde_key (= cde_canonical.cde_id) -> cde_name.
    const nameRows = await query<{ cde_id: string; cde_name: string }>(
      `SELECT cde_id, cde_name FROM cde_canonical`,
    );
    const nameByKey = new Map<string, string>();
    for (const r of nameRows) nameByKey.set(String(r.cde_id), String(r.cde_name));

    return forms.map((f) => {
      const keys = f.member_cde_keys
        ? String(f.member_cde_keys).split('|').filter(Boolean)
        : [];
      const items: CrfItem[] = keys.map((k) => ({
        type: 'cde' as const,
        // Prefer the resolvable cde_name; fall back to the raw key when the member
        // CDE isn't in this catalog/collection slice (so it still shows something).
        ref: nameByKey.get(k) ?? k,
        label: null,
        instructions: null,
      }));
      return {
        id: String(f.id),
        crf_name: String(f.form_key),
        title: String(f.form_name),
        description: null,
        instructions: null,
        version: '1.0',
        disease_scope: null,
        estimated_duration_minutes: null,
        collection_frequency: null,
        external_url: null,
        study_type: null,
        // Forms are not recommendation-tiered; leave status unset (badges default
        // to "Qualified"). The catalog-vs-custom split stays on `source`.
        registration_status: null,
        items,
        source: 'seeded',
      };
    });
  } catch {
    // No `form` view (e.g. running against a pre-v2 catalog / real discover data).
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
