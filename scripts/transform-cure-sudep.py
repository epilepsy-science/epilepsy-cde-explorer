#!/usr/bin/env python3
"""Transforms the CURE Epilepsy SUDEP Preclinical CDE module workbooks
(under data/cure-sudep/) into Pennsieve-format JSONL records that
prepare-data.mjs can ingest.

The seven `*-Module.xlsx` files are NINDS-style CDE template sheets: row 1 is
the column header, row 2 is the per-column Required/Optional designation, and
rows 3+ are one CDE each. The columns map almost 1:1 onto our `cde` model, so
this transform is mostly a header-keyed passthrough plus a few enum
normalizations. It mirrors scripts/transform-pte-clinical-2.mjs.

Modelling choices (see docs/data-model.md):
  - One source: source_key "cure-sudep", study_type "Preclinical".
  - Each module workbook -> one CRF (7 total).
  - Column L "Name of Bundle" -> the SUBDOMAIN taxonomy level, NOT a `bundle`
    record. In this repo a `bundle` is the strict ODM sense — CDEs that *must*
    be captured together (e.g. Age value + Age unit). The spreadsheets' groups
    ("Animal Information", "Anesthesia", "EEG settings", ...) are thematic
    categories whose members can be captured independently, so they belong in
    the taxonomy, not the bundle model. We emit no bundles for now; genuine
    atomic groups can be promoted later after curation review.
  - disease scope: these are Sudden Unexpected Death in EPILEPSY CDEs, so
    disease_epilepsy = "Y". The module sheets carry no Core/Recommended/
    Supplemental tier, so classification_epilepsy is left null (a curation task).
  - taxonomy / categorization: domain = module display name, subdomain = group
    name, so the Tree view renders Module -> Group -> CDE.

Inputs  (data/cure-sudep/*-Module.xlsx)
Outputs (data/cure-sudep/metadata/...):
  models/{cde,cde_classification,crf,bundle,provenance}/versions/1/{schema.json,records.jsonl}
  relationships.csv
  ../manifest.json

Usage:
  python3 scripts/transform-cure-sudep.py
  node scripts/prepare-data.mjs            # (then rebuild parquet)
"""

import glob
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

import openpyxl

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIR = os.path.join(ROOT, "data", "cure-sudep")
META = os.path.join(SRC_DIR, "metadata")
TODAY = datetime.now(timezone.utc).strftime("%Y-%m-%d")

SOURCE_KEY = "cure-sudep"
SOURCE_LABEL = "CURE SUDEP Preclinical CDEs"
STUDY_TYPE = "Preclinical"
STEWARD_ORG = "CURE Epilepsy"
CURE_URL = (
    "https://www.cureepilepsy.org/for-researchers/research-resources/"
    "sudden-unexpected-death-in-epilepsy-sudep-cdes/"
)

# filename token (between "SUDEP-Preclinical-" and "-Module.xlsx") -> display name
MODULE_DISPLAY = {
    "Core-and-Death": "Core and Death-Related Information",
    "Additional-Phenotypes": "Additional Phenotypes",
    "Electrophysiology": "Ex vivo / In vitro Electrophysiology",
    "Imaging": "Imaging",
    "Neurological-Variables": "Neurological Variables",
    "Physiologic-Measures": "Physiologic Measures",
    "Therapeutics-and-Pharmacology": "Therapeutics and Pharmacology",
}
# module token -> the published Case Report Form PDF that accompanies it
MODULE_CRF_PDF = {
    "Core-and-Death": "Lab-Fillable-Form_SUDEP-Preclinical-Core-and-Death-Related-Information-Case-Report-Form.pdf",
    "Additional-Phenotypes": "Lab-Fillable-Form_SUDEP-Preclinical-Additional-Phenotypes-Case-Report-Form.pdf",
    "Electrophysiology": "Lab-Fillable-Form_SUDEP-Preclinical-Ex-vivo-In-vitro-Electrophysiology-Case-Report-Form.pdf",
    "Imaging": "Lab-Fillable-Form_SUDEP-Preclinical-Imaging-Case-Report-Form.pdf",
    "Neurological-Variables": "Lab-Fillable-Form_SUDEP-Preclinical-Neurological-Variables-Case-Report-Form.pdf",
    "Physiologic-Measures": "Lab-Fillable-Form_SUDEP-Preclinical-Physiologic-Measures-Case-Report-Form.pdf",
    "Therapeutics-and-Pharmacology": "Lab-Fillable-Form_SUDEP-Preclinical-Therapeutics-and-Pharmacology-Case-Report-Form.pdf",
}

REQ_WORDS = {"required", "optional", "conditionally required", "conditional", "recommended"}


# ── Helpers ──────────────────────────────────────────────────────────────────

def uid(s):
    h = hashlib.sha1(f"{SOURCE_KEY}:{s}".encode("utf-8")).hexdigest()
    return f"{h[0:8]}-{h[8:12]}-5{h[13:16]}-8{h[17:20]}-{h[20:32]}"


def null_if_empty(v):
    if v is None:
        return None
    t = str(v).strip()
    return t if t else None


def pipe_join(v):
    """Normalize the source's ' | ' / newline-separated lists to '|'-joined,
    dropping empty segments. Returns None when nothing is left."""
    if v is None:
        return None
    parts = re.split(r"\s*[|\n]\s*", str(v))
    parts = [p.strip() for p in parts if p and p.strip()]
    return "|".join(parts) if parts else None


def map_data_type(raw):
    v = null_if_empty(raw)
    if not v:
        return "Other"
    low = v.lower()
    if low == "value list":
        return "Value List"
    if low in ("number", "numeric"):
        return "Number"
    if low in ("datetime", "date time"):
        return "Datetime"
    if low == "date":
        return "Date"
    if low == "time":
        return "Time"
    if low in ("text", "alphanumeric", "free text"):
        return "Text"
    if low in ("file", "geolocation"):
        return "File/URI/URL" if low == "file" else "Geolocation"
    if "uri" in low or "url" in low:
        return "File/URI/URL"
    return "Other"


def slug(s):
    return re.sub(r"^_+|_+$", "", re.sub(r"[^a-zA-Z0-9]+", "_", str(s)))[:80]


def module_token(path):
    m = re.search(r"SUDEP-Preclinical-(.+?)-Module\.xlsx$", os.path.basename(path))
    return m.group(1) if m else os.path.basename(path)


# ── Header mapping ───────────────────────────────────────────────────────────
# Map each worksheet header cell to one of our field keys. PV/DEC fields both
# say "concept identifier"/"terminology source", so check "permissible value"
# first. The header "Permissible Value (PV) Labels" appears twice (a primary
# column + an overflow column); both resolve to pv_labels and are merged.

def classify_header(h):
    t = re.sub(r"\s+", " ", (h or "").strip()).lower()
    if not t:
        return None
    pv = "permissible value" in t or "(pv)" in t or t.startswith("codes for")
    if pv:
        if "definition" in t:
            return "pv_definitions"
        if "concept identifier" in t:
            return "pv_concept_identifiers"
        if "terminology source" in t:
            return "pv_terminology_sources"
        if "code system" in t:
            return "pv_code_systems"
        if "codes for" in t or t.startswith("codes "):
            return "pv_codes"
        if "label" in t:
            return "pv_labels"
        if "url" in t or "uri" in t:
            return "pv_url"
        return None
    if t == "cde name" or t.startswith("cde name"):
        return "cde_name"
    if "nlm identifier" in t:
        return "nlm_identifier"
    if "other identifier" in t:
        return "other_identifiers"
    if "cde data type" in t:
        return "cde_data_type"
    if "cde definition" in t:
        return "cde_definition"
    if "preferred question" in t:
        return "preferred_question_text"
    if "unit of measure" in t:
        return "unit_of_measure"
    if "cde source" in t:
        return "cde_source"
    if "data element concept" in t or ("dec" in t and "identifier" in t):
        return "dec_identifier"
    if "terminology source" in t:  # DEC terminology source (PV already handled)
        return "dec_terminology_source"
    if "cde type" in t:
        return "cde_type"
    # The spreadsheets call this "Name of Bundle", but semantically it's a
    # thematic category, so we map it to the subdomain taxonomy level (not a
    # `bundle` record). See the module docstring.
    if "name of bundle" in t or t == "bundle":
        return "group_name"
    if "reference" in t:
        return "references"
    if "keyword" in t or "tag" in t:
        return "keywords"
    return None


def read_module(path):
    """Return (module_token, [row_dicts]) for the first worksheet of a module."""
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb[wb.sheetnames[0]]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return module_token(path), []

    # Find the header row (the one whose first non-empty cell is "CDE Name").
    header_idx = 0
    for i, r in enumerate(rows[:6]):
        if any(c and "cde name" in str(c).strip().lower() for c in r):
            header_idx = i
            break
    header = rows[header_idx]

    # Build column index -> field key. pv_labels may map to two columns.
    col_field = {}
    pv_label_cols = []
    for ci, cell in enumerate(header):
        key = classify_header(cell)
        if key == "pv_labels":
            pv_label_cols.append(ci)
        elif key:
            col_field.setdefault(ci, key)

    out = []
    for r in rows[header_idx + 1:]:
        name_cells = [r[ci] for ci, k in col_field.items() if k == "cde_name"]
        name = null_if_empty(name_cells[0]) if name_cells else None
        if not name:
            continue
        if name.lower() in REQ_WORDS:  # the row-2 Required/Optional designation row
            continue
        rec = {}
        for ci, key in col_field.items():
            if ci < len(r):
                rec[key] = r[ci]
        # merge the (up to two) PV label columns
        labels = []
        for ci in pv_label_cols:
            if ci < len(r):
                lj = pipe_join(r[ci])
                if lj:
                    labels.append(lj)
        rec["pv_labels"] = "|".join(labels) if labels else None
        out.append(rec)
    return module_token(path), out


# ── Build records ────────────────────────────────────────────────────────────

def build(modules):
    provenance = {
        "id": uid("provenance"),
        "data": {
            "source_key": SOURCE_KEY,
            "label": SOURCE_LABEL,
            "study_type": STUDY_TYPE,
            "kind": "production",
        },
    }

    cde_by_key = {}          # cde_key -> {id, name}
    cde_records = []
    cls_records = []
    crf_records = []

    classifies = []          # (cls_id, cde_id)
    sourced = []             # (record_id, provenance_id)
    seen_cls = set()

    for mod_token, rows in modules:
        mod_display = MODULE_DISPLAY.get(mod_token, mod_token.replace("-", " "))
        crf_items = []
        seen_in_crf = set()

        for r in rows:
            name = null_if_empty(r.get("cde_name"))
            if not name:
                continue
            nlm = null_if_empty(r.get("nlm_identifier"))
            cde_key = nlm if nlm else "name:" + re.sub(r"[^a-z0-9]+", " ", name.lower()).strip()

            # ── CDE (one per cde_key, first occurrence wins) ──
            if cde_key not in cde_by_key:
                cde_id = uid(f"cde:{cde_key}")
                cde_by_key[cde_key] = {"id": cde_id, "name": name}
                cde_records.append({
                    "id": cde_id,
                    "data": {
                        "cde_name": name,
                        "aliases": None,
                        "cde_data_type": map_data_type(r.get("cde_data_type")),
                        "cde_definition": null_if_empty(r.get("cde_definition")) or name,
                        "cde_source": SOURCE_LABEL,
                        "cde_type": null_if_empty(r.get("cde_type")),
                        "steward_org": STEWARD_ORG,
                        "registration_status": None,
                        "keywords": pipe_join(r.get("keywords")),
                        "preferred_question_text": null_if_empty(r.get("preferred_question_text")),
                        "pv_codes": pipe_join(r.get("pv_codes")),
                        "pv_labels": null_if_empty(r.get("pv_labels")),
                        "pv_definitions": pipe_join(r.get("pv_definitions")),
                        "pv_code_systems": pipe_join(r.get("pv_code_systems")),
                        "pv_concept_identifiers": pipe_join(r.get("pv_concept_identifiers")),
                        "pv_terminology_sources": pipe_join(r.get("pv_terminology_sources")),
                        "unit_of_measure": null_if_empty(r.get("unit_of_measure")),
                        "size": None,
                        "min_value": None,
                        "max_value": None,
                        "cde_origin": "COLLECTED",
                        "population": None,
                        "cdisc_domain": None,
                        "cdisc_variable_name": None,
                        "cdisc_variable_label": None,
                        "references": null_if_empty(r.get("references")),
                        "nlm_identifier": nlm,
                        "dec_identifier": null_if_empty(r.get("dec_identifier")),
                        "dec_terminology_source": null_if_empty(r.get("dec_terminology_source")),
                        "dec_name": None,
                        "other_identifiers": null_if_empty(r.get("other_identifiers")),
                        "nlm_view_url": None,
                        "cde_id_verified": None,
                    },
                })
            cde_id = cde_by_key[cde_key]["id"]

            # ── CRF item (CDE in module order, deduped within the module) ──
            if name not in seen_in_crf:
                seen_in_crf.add(name)
                crf_items.append({"type": "cde", "ref": name})

            # The spreadsheet "Name of Bundle" group becomes the subdomain
            # taxonomy level (Module -> Group -> CDE), not a bundle record.
            group = null_if_empty(r.get("group_name"))

            # ── Classification (one per CDE × module) ──
            cls_key = f"{cde_key}::{mod_token}"
            if cls_key in seen_cls:
                continue
            seen_cls.add(cls_key)
            cls_id = uid(f"cls:{cls_key}")
            cls_records.append({
                "id": cls_id,
                "data": {
                    "variable_name": f"{mod_token}:{slug(name)}",
                    "version_name": f"{SOURCE_LABEL} · {mod_display}",
                    "version_date": TODAY,
                    "version_date_flag": None,
                    "notes": None,
                    "additional_instructions": None,
                    "disease_epilepsy": "Y",
                    "classification_epilepsy": None,
                    "disease_agnostic": "N",
                    "classification_agnostic": None,
                    "disease_neurotrauma": "N",
                    "classification_neurotrauma": None,
                    "disease_tbi": "N",
                    "classification_tbi": None,
                    "disease_pte": "N",
                    "classification_pte": None,
                    "disease_sci": "N",
                    "classification_sci": None,
                    "domain": mod_display,
                    "subdomain": group,
                    "category": mod_display,
                    "bundle_name": None,
                    "ninds_crf_id": None,
                    "ninds_crf_name": mod_display,
                    "working_group": "CURE Epilepsy SUDEP CDE Working Group",
                },
            })
            classifies.append((cls_id, cde_id))
            sourced.append((cls_id, provenance["id"]))

        # ── CRF (one per module) ──
        crf_id = uid(f"crf:{mod_token}")
        pdf = MODULE_CRF_PDF.get(mod_token)
        crf_records.append({
            "id": crf_id,
            "data": {
                "crf_name": slug(f"sudep_{mod_token}"),
                "title": f"SUDEP Preclinical — {mod_display}",
                "description": (
                    "CURE Epilepsy SUDEP Standardization Tool Project — preclinical "
                    f"{mod_display} module." + (f" Case Report Form: {pdf}" if pdf else "")
                ),
                "instructions": None,
                "external_url": CURE_URL,
                "version": "1.0",
                "disease_scope": "SUDEP (Preclinical)",
                "estimated_duration_minutes": None,
                "collection_frequency": None,
                "registration_status": None,
                "items": crf_items,
            },
        })
        sourced.append((crf_id, provenance["id"]))

    for v in cde_by_key.values():
        sourced.append((v["id"], provenance["id"]))

    return {
        "provenance": provenance,
        "cde_records": cde_records,
        "cls_records": cls_records,
        "crf_records": crf_records,
        "rels": {"classifies": classifies, "sourced": sourced},
    }


# ── Emit ─────────────────────────────────────────────────────────────────────

def open_schema(required):
    return {
        "type": "object",
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "required": required,
        "properties": {},
    }


def write_jsonl(model_dir, schema, records):
    os.makedirs(model_dir, exist_ok=True)
    with open(os.path.join(model_dir, "schema.json"), "w") as f:
        json.dump(schema, f)
    lines = "\n".join(json.dumps(r, ensure_ascii=False) for r in records)
    with open(os.path.join(model_dir, "records.jsonl"), "w") as f:
        f.write(lines + ("\n" if lines else ""))


def emit(out):
    os.makedirs(META, exist_ok=True)
    write_jsonl(os.path.join(META, "models/cde/versions/1"),
                open_schema(["cde_name", "cde_data_type", "cde_definition", "cde_source"]),
                out["cde_records"])
    write_jsonl(os.path.join(META, "models/cde_classification/versions/1"),
                open_schema(["variable_name"]), out["cls_records"])
    write_jsonl(os.path.join(META, "models/crf/versions/1"),
                open_schema(["crf_name", "title", "version", "items"]), out["crf_records"])
    write_jsonl(os.path.join(META, "models/provenance/versions/1"),
                open_schema(["source_key", "label"]), [out["provenance"]])

    # No `bundle` model: the spreadsheet groups are taxonomy, not bundles.
    # Remove any stale bundle model left by an earlier run of this extractor.
    stale_bundle = os.path.join(META, "models/bundle")
    if os.path.isdir(stale_bundle):
        import shutil
        shutil.rmtree(stale_bundle)

    rel_lines = ["source_record_id,target_record_id,relationship_type"]
    for s, t in out["rels"]["classifies"]:
        rel_lines.append(f"{s},{t},CLASSIFIES")
    for s, t in out["rels"]["sourced"]:
        rel_lines.append(f"{s},{t},SOURCED_FROM")
    with open(os.path.join(META, "relationships.csv"), "w") as f:
        f.write("\n".join(rel_lines) + "\n")

    with open(os.path.join(SRC_DIR, "manifest.json"), "w") as f:
        json.dump({
            "source_key": SOURCE_KEY,
            "label": SOURCE_LABEL,
            "study_type": STUDY_TYPE,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "cde_count": len(out["cde_records"]),
            "crf_count": len(out["crf_records"]),
            "classification_count": len(out["cls_records"]),
        }, f, indent=2)
        f.write("\n")


def main():
    paths = sorted(glob.glob(os.path.join(SRC_DIR, "*-Module.xlsx")))
    if not paths:
        print(f"No *-Module.xlsx files found under {SRC_DIR}", file=sys.stderr)
        sys.exit(1)

    modules = []
    for p in paths:
        tok, rows = read_module(p)
        print(f"  {tok:32s} {len(rows):3d} CDE rows")
        modules.append((tok, rows))

    out = build(modules)
    emit(out)

    groups = {(c["data"]["domain"], c["data"]["subdomain"])
              for c in out["cls_records"] if c["data"]["subdomain"]}
    print(
        f"\nWrote {META}:\n"
        f"  cde:                {len(out['cde_records'])}\n"
        f"  cde_classification: {len(out['cls_records'])}\n"
        f"  crf:                {len(out['crf_records'])}\n"
        f"  provenance:         1\n"
        f"  (taxonomy: {len({d for d, _ in groups})} domains / "
        f"{len(groups)} domain×subdomain groups; no bundles by design)\n"
    )
    print("Next:  node scripts/prepare-data.mjs")


if __name__ == "__main__":
    main()
