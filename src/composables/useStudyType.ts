import { ref, watch, readonly } from 'vue';

// Global Clinical / Preclinical filter. Sits at the app level (top nav) so
// it pivots every view at once. Persists to localStorage.
export type StudyType = 'Clinical' | 'Preclinical';
export type StudyTypeFilter = StudyType | 'all';

const STORAGE_KEY = 'cde-review.study-type-filter';

function read(): StudyTypeFilter {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'Clinical' || v === 'Preclinical' || v === 'all') return v;
  } catch {}
  return 'all';
}

const filter = ref<StudyTypeFilter>(read());
watch(filter, (v) => {
  try { localStorage.setItem(STORAGE_KEY, v); } catch {}
});

export function useStudyType() {
  /** SQL `WHERE` fragment for a column holding a comma-joined study_types list.
   *  For single-typed models (crf/bundle) pass colName = '_study_type'. */
  function clause(colName = 'study_types'): string | null {
    if (filter.value === 'all') return null;
    return `',' || COALESCE(${colName}, '') || ',' LIKE '%,${filter.value},%'`;
  }

  return {
    filter,
    readonly: readonly(filter),
    clause,
  };
}
