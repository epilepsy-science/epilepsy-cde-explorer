// Concept-layer queries. Concepts are derived globally at data-prep time
// (see scripts/prepare-data.mjs) and surfaced as two DuckDB views in
// useDuckDB.ts: `concept` and `cde_represents_concept`.
//
// The composable doesn't hold reactive state — concepts are queried on
// demand by the views/components that need them. Callers cache results in
// their own component state where appropriate.

import { useDuckDB } from './useDuckDB';
import type { ConceptRole, ConceptRow } from '@/types';

export interface ConceptListRow extends ConceptRow {
  /** How many CDEs in the library currently point at this concept. */
  cde_count: number;
}

export interface CdeForConcept {
  cde_id: string;
  cde_name: string;
  variable_name: string | null;
  cde_data_type: string | null;
  bundle_name: string | null;
  bundle_domain: string | null;
  role: ConceptRole;
}

export interface ConceptForCde {
  id: string;
  source: string;
  identifier: string;
  cui: string | null;
  preferred_label: string | null;
  definition: string | null;
  role: ConceptRole;
}

/** Display label for a concept. Falls back to `<source>:<identifier>` until
 *  the UTS cache populates `preferred_label` in Phase 4. */
export function conceptLabel(c: { preferred_label?: string | null; source: string; identifier: string }): string {
  return c.preferred_label?.trim() || `${c.source}:${c.identifier}`;
}

export function useConcepts() {
  const { query } = useDuckDB();

  async function listConcepts(): Promise<ConceptListRow[]> {
    return query<ConceptListRow>(`
      SELECT
        c.id,
        c.source,
        c.identifier,
        c.cui,
        c.preferred_label,
        c.definition,
        c.alt_labels,
        count(DISTINCT r.cde_id) AS cde_count
      FROM concept c
      LEFT JOIN cde_represents_concept r ON r.concept_id = c.id
      GROUP BY c.id, c.source, c.identifier, c.cui, c.preferred_label, c.definition, c.alt_labels
      ORDER BY cde_count DESC, c.source, c.identifier
    `);
  }

  async function getConcept(id: string): Promise<ConceptListRow | null> {
    const rows = await query<ConceptListRow>(
      `
      SELECT
        c.id, c.source, c.identifier, c.cui,
        c.preferred_label, c.definition, c.alt_labels,
        count(DISTINCT r.cde_id) AS cde_count
      FROM concept c
      LEFT JOIN cde_represents_concept r ON r.concept_id = c.id
      WHERE c.id = ?
      GROUP BY c.id, c.source, c.identifier, c.cui, c.preferred_label, c.definition, c.alt_labels
    `,
      [id],
    );
    return rows[0] ?? null;
  }

  async function getCdesForConcept(conceptId: string): Promise<CdeForConcept[]> {
    return query<CdeForConcept>(
      `
      SELECT
        f.cde_id,
        f.cde_name,
        f.variable_name,
        f.cde_data_type,
        f.bundle_name,
        f.bundle_domain,
        r.role
      FROM cde_represents_concept r
      JOIN cde_full f ON f.cde_id = r.cde_id
      WHERE r.concept_id = ?
      ORDER BY r.role, f.cde_name
    `,
      [conceptId],
    );
  }

  async function getConceptsForCde(cdeId: string): Promise<ConceptForCde[]> {
    return query<ConceptForCde>(
      `
      SELECT
        c.id, c.source, c.identifier, c.cui,
        c.preferred_label, c.definition,
        r.role
      FROM cde_represents_concept r
      JOIN concept c ON c.id = r.concept_id
      WHERE r.cde_id = ?
      ORDER BY r.role, c.source, c.identifier
    `,
      [cdeId],
    );
  }

  return {
    listConcepts,
    getConcept,
    getCdesForConcept,
    getConceptsForCde,
  };
}
