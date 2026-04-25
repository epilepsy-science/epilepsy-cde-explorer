import { ref } from 'vue';

export type DiseaseKey =
  | 'pte'
  | 'tbi'
  | 'sci'
  | 'neurotrauma'
  | 'epilepsy'
  | 'agnostic'
  | 'all';

export interface DiseaseOption {
  key: DiseaseKey;
  label: string;
  longLabel: string;
  column: string | null; // null = no disease filter (all CDEs)
}

export const DISEASE_OPTIONS: DiseaseOption[] = [
  { key: 'pte', label: 'PTE', longLabel: 'Post-Traumatic Epilepsy', column: 'disease_pte' },
  { key: 'tbi', label: 'TBI', longLabel: 'Traumatic Brain Injury', column: 'disease_tbi' },
  { key: 'sci', label: 'SCI', longLabel: 'Spinal Cord Injury', column: 'disease_sci' },
  { key: 'neurotrauma', label: 'Neurotrauma', longLabel: 'Neurotrauma (general)', column: 'disease_neurotrauma' },
  { key: 'epilepsy', label: 'Epilepsy', longLabel: 'Epilepsy (NINDS)', column: 'disease_epilepsy' },
  { key: 'agnostic', label: 'Agnostic', longLabel: 'Disease-Agnostic', column: 'disease_agnostic' },
  { key: 'all', label: 'All', longLabel: 'All CDEs', column: null },
];

// Default to 'all' — works for any dataset regardless of which disease_X
// columns are populated. User can pivot via the Research focus control.
const lens = ref<DiseaseKey>('all');

export function useDiseaseLens() {
  return {
    lens,
    options: DISEASE_OPTIONS,
    option: (key: DiseaseKey) =>
      DISEASE_OPTIONS.find((o) => o.key === key) ?? DISEASE_OPTIONS[0],
    /** Returns `disease_X = 'Y'` SQL clause, or null for 'all'. */
    clause: (key: DiseaseKey = lens.value) => {
      const opt = DISEASE_OPTIONS.find((o) => o.key === key);
      if (!opt || !opt.column) return null;
      return `${opt.column} = 'Y'`;
    },
    /** Column name of the classification_X column matching the lens. */
    classificationColumn: (key: DiseaseKey = lens.value) => {
      const map: Record<DiseaseKey, string | null> = {
        pte: 'classification_pte',
        tbi: 'classification_tbi',
        sci: 'classification_sci',
        neurotrauma: 'classification_neurotrauma',
        epilepsy: 'classification_epilepsy',
        agnostic: 'classification_agnostic',
        all: null,
      };
      return map[key];
    },
  };
}
