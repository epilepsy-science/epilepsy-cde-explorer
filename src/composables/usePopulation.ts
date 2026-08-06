import { ref, watch, readonly } from 'vue';

// Global population lens (Adult / Pediatric / Preclinical) — the v2 classification
// scoping axis. Sits alongside the disease "Research focus" lens on Explore and
// pivots every Explore view at once. Persists to localStorage. Replaces the old
// Clinical/Preclinical study-type lens (v2 carries this on the classification, not
// on provenance).
export type PopulationFilter = string; // 'all' | a population value

const STORAGE_KEY = 'cde-review.population-filter';

function read(): PopulationFilter {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) return v;
  } catch {}
  return 'all';
}

const filter = ref<PopulationFilter>(read());
watch(filter, (v) => {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {}
});

// Lens options: All + the common v2 populations. Kept small + fixed so the lens
// reads as a simple pivot; rarer values are still reachable via the /cdes
// Population facet.
export const POPULATION_OPTIONS: Array<{ value: PopulationFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'Adult', label: 'Adult' },
  { value: 'Pediatric', label: 'Pediatric' },
  { value: 'Preclinical', label: 'Preclinical' },
];

export function usePopulation() {
  /** SQL `WHERE` fragment matching the selected population. Works on either a
   *  single-value column (cde_full.cde_population) or a pipe-joined one
   *  (cde_canonical.cde_populations) via a delimited LIKE. */
  function clause(colName = 'cde_population'): string | null {
    if (filter.value === 'all') return null;
    const safe = filter.value.replace(/'/g, "''");
    return `'|' || COALESCE(${colName}, '') || '|' LIKE '%|${safe}|%'`;
  }

  return {
    filter,
    readonly: readonly(filter),
    clause,
  };
}
