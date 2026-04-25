<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue';
import VChart from 'vue-echarts';
import { use } from 'echarts/core';
import { TreemapChart } from 'echarts/charts';
import { TooltipComponent, TitleComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useDuckDB } from '@/composables/useDuckDB';
import { useDiseaseLens } from '@/composables/useDiseaseLens';
import { useStudyType } from '@/composables/useStudyType';
import CdeDetailDrawer from '@/components/CdeDetailDrawer.vue';
import type { CdeRow } from '@/types';

use([TreemapChart, TooltipComponent, TitleComponent, CanvasRenderer]);

const { status, query } = useDuckDB();
const { lens, option, clause } = useDiseaseLens();
const { filter: studyTypeFilter, clause: studyTypeClause } = useStudyType();

// cde_full is enriched in this project with cde_domain / cde_subdomain /
// cde_category — the per-CDE taxonomy that works for bundled and standalone
// CDEs alike.
interface EnrichedCde extends CdeRow {
  cde_domain: string | null;
  cde_subdomain: string | null;
  cde_category: string | null;
}

const rows = ref<EnrichedCde[]>([]);
const loading = ref(false);

const selectedCde = ref<CdeRow | null>(null);
const drawerOpen = ref(false);

async function load() {
  if (status.value !== 'ready') return;
  loading.value = true;
  try {
    const parts: string[] = [];
    const lensClause = clause();
    if (lensClause) parts.push(lensClause);
    const stClause = studyTypeClause();
    if (stClause) parts.push(stClause);
    const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
    const data = await query<EnrichedCde>(`
      SELECT * FROM cde_full ${where}
    `);
    rows.value = data;
  } finally {
    loading.value = false;
  }
}

watch([status, lens, studyTypeFilter], load);
onMounted(load);

// One base hue per domain. Child tile shades are computed explicitly below so
// we know each rendered color and can pick a contrasting label per tile.
const DEFAULT_PALETTE = [
  '#3e7877', '#7c3aed', '#ea580c', '#059669', '#e11d48', '#0891b2',
  '#ca8a04', '#db2777', '#0f766e', '#4f46e5', '#15803d', '#9333ea',
];

// ── Color helpers ───────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x)))
    .toString(16)
    .padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
      case gn: h = (bn - rn) / d + 2; break;
      default: h = (rn - gn) / d + 4;
    }
    h *= 60;
  }
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = h / 360;
  return [
    hue2rgb(p, q, hk + 1 / 3) * 255,
    hue2rgb(p, q, hk) * 255,
    hue2rgb(p, q, hk - 1 / 3) * 255,
  ];
}

/** Shift a hex color's HSL lightness to a specific target L (0..1). */
function withLightness(hex: string, targetL: number): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s] = rgbToHsl(r, g, b);
  const [r2, g2, b2] = hslToRgb(h, s, Math.max(0, Math.min(1, targetL)));
  return rgbToHex(r2, g2, b2);
}

/** WCAG relative luminance (0..1). */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const cn = c / 255;
    return cn <= 0.03928 ? cn / 12.92 : Math.pow((cn + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pick white or near-black for a given background. Threshold 0.45 nudges
 *  mid-tone tiles (which often favor dark labels for crispness) toward
 *  dark — purely cosmetic, feel free to tune. */
function labelColorFor(bg: string): string {
  return luminance(bg) < 0.45 ? '#ffffff' : '#1f2937';
}

/** Evenly distribute lightness values across N siblings in a given range. */
function spreadLightness(count: number, min: number, max: number): number[] {
  if (count <= 1) return [(min + max) / 2];
  const step = (max - min) / (count - 1);
  return Array.from({ length: count }, (_, i) => min + step * i);
}

// The treemap node shape — depth 2 nodes are either a bundle (children =
// member CDEs) or a standalone CDE acting as a leaf. The click handler checks
// `cde` to decide drawer vs. zoom.
interface TreeNode {
  name: string;
  value?: number;
  cde?: CdeRow;
  children?: TreeNode[];
  itemStyle?: { color?: string };
  upperLabel?: { color?: string };
  label?: { color?: string };
}

const option_ = computed(() => {
  // Build 2-or-3 level tree keyed by the CDE's own domain.
  //   domain
  //     ├─ Bundle (container)
  //     │    └─ CDE (leaf → drawer)
  //     └─ CDE (leaf → drawer, standalone)
  const byDomain = new Map<string, {
    bundles: Map<string, { bundle_name: string; cdes: CdeRow[] }>;
    standalone: CdeRow[];
  }>();

  for (const r of rows.value) {
    const domain = r.cde_domain || 'Unclassified';
    if (!byDomain.has(domain)) {
      byDomain.set(domain, { bundles: new Map(), standalone: [] });
    }
    const d = byDomain.get(domain)!;
    if (r.bundle_id) {
      if (!d.bundles.has(r.bundle_id)) {
        d.bundles.set(r.bundle_id, { bundle_name: r.bundle_name || 'Unnamed', cdes: [] });
      }
      d.bundles.get(r.bundle_id)!.cdes.push(r);
    } else {
      d.standalone.push(r);
    }
  }

  let paletteIdx = 0;
  const data: TreeNode[] = [...byDomain.entries()].map(([domain, { bundles, standalone }]) => {
    const baseHex = DEFAULT_PALETTE[paletteIdx++ % DEFAULT_PALETTE.length];

    // Depth-2 siblings (bundles + standalones) spread across a lightness band.
    // Narrower band = tighter kinship to the domain; wider = more distinction.
    const depth2Count = bundles.size + standalone.length;
    const d2Lightness = spreadLightness(depth2Count, 0.42, 0.62);

    const children: TreeNode[] = [];
    let d2Idx = 0;

    // Bundles → containers at depth 2 with CDE leaves at depth 3.
    for (const { bundle_name, cdes } of bundles.values()) {
      const bundleHex = withLightness(baseHex, d2Lightness[d2Idx++]);
      const bundleLabel = labelColorFor(bundleHex);

      // CDE leaves spread slightly lighter than their bundle parent.
      const d3Lightness = spreadLightness(cdes.length, 0.55, 0.78);
      const leafChildren: TreeNode[] = cdes.map((cde, i) => {
        const leafHex = withLightness(baseHex, d3Lightness[i]);
        return {
          name: cde.cde_name,
          value: 1,
          cde,
          itemStyle: { color: leafHex },
          label: { color: labelColorFor(leafHex) },
        };
      });

      children.push({
        name: bundle_name,
        itemStyle: { color: bundleHex },
        upperLabel: { color: bundleLabel },
        label: { color: bundleLabel },
        children: leafChildren,
      });
    }

    // Standalone CDEs → leaves at depth 2 (same level as bundles).
    for (const cde of standalone) {
      const leafHex = withLightness(baseHex, d2Lightness[d2Idx++]);
      children.push({
        name: cde.cde_name,
        value: 1,
        cde,
        itemStyle: { color: leafHex },
        label: { color: labelColorFor(leafHex) },
      });
    }

    // Domain tiles themselves use the base hex; upperLabel contrasts against it.
    return {
      name: domain,
      itemStyle: { color: baseHex },
      upperLabel: { color: labelColorFor(baseHex) },
      label: { color: labelColorFor(baseHex) },
      children,
    };
  });

  return {
    tooltip: {
      formatter: (info: { name: string; value: number; data?: TreeNode }) => {
        const cde = info.data?.cde;
        if (cde) {
          return `<strong>${cde.cde_name}</strong><br/>
                  <span style="color:#888">${cde.bundle_name ? cde.bundle_name + ' · ' : ''}${cde.cde_data_type}</span>`;
        }
        return `<strong>${info.name}</strong><br/>${info.value ?? ''} CDEs`;
      },
    },
    series: [
      {
        type: 'treemap',
        name: 'All domains',
        roam: false,
        nodeClick: 'zoomToNode',
        // Depth-2 cap: the initial view shows domain → (bundle or standalone
        // CDE). Drilling into a bundle reveals its CDE leaves; standalone
        // CDEs don't drill (no children) — click opens the drawer instead.
        leafDepth: 2,
        breadcrumb: {
          show: true,
          top: 0,
          left: 4,
          height: 26,
          emptyItemWidth: 24,
          itemStyle: {
            color: '#e6eeed',
            borderColor: '#b8cdcd',
            borderWidth: 1,
            textStyle: { color: '#3e7877', fontSize: 12, fontWeight: 500 },
          },
          emphasis: {
            itemStyle: {
              color: '#d5e2e1',
              textStyle: { color: '#3e7877' },
            },
          },
        },
        // Per-node `label.color` is set when building the tree — picked from
        // the tile's actual rendered color via WCAG luminance.
        label: {
          show: true,
          formatter: '{b}',
          fontSize: 13,
          overflow: 'truncate',
        },
        upperLabel: {
          show: true,
          height: 28,
          fontSize: 13,
          fontWeight: 600,
        },
        itemStyle: {
          borderColor: '#fff',
          borderWidth: 1,
          gapWidth: 2,
        },
        levels: [
          // depth 0 (root)
          { itemStyle: { borderWidth: 0, gapWidth: 4 } },
          // depth 1: domain
          {
            itemStyle: { gapWidth: 2 },
            upperLabel: { show: true },
          },
          // depth 2: bundle or standalone CDE
          {
            itemStyle: { gapWidth: 1, borderWidth: 1 },
            upperLabel: { show: true, height: 24, fontSize: 12 },
            label: { show: true, fontSize: 12 },
          },
          // depth 3: CDE leaf inside a bundle
          {
            itemStyle: { gapWidth: 1, borderWidth: 1 },
            label: { show: true, fontSize: 12 },
          },
        ],
        data,
      },
    ],
  };
});

// ECharts' click event has a wide data type; narrow at the boundary.
function onChartClick(params: unknown) {
  const data = (params as { data?: TreeNode })?.data;
  const cde = data?.cde;
  if (cde) {
    selectedCde.value = cde;
    drawerOpen.value = true;
  }
}
</script>

<template>
  <div class="treemap-tab" v-loading="loading">
    <p class="subtle">
      All CDEs grouped by domain, then by bundle (standalone CDEs sit at the
      bundle level). Scoped to <strong>{{ option(lens).longLabel }}</strong>.
      Click a bundle to drill into its fields; click a CDE to open its details.
    </p>
    <div class="treemap-wrap">
      <VChart
        class="treemap"
        :option="option_"
        @click="onChartClick"
        autoresize
      />
    </div>

    <CdeDetailDrawer v-model="drawerOpen" :cde="selectedCde" />
  </div>
</template>

<style lang="scss" scoped>
.treemap-tab {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  height: 100%;
}

.treemap-wrap {
  background: $white;
  border: 1px solid $lineColor2;
  border-radius: 2px;
  padding: 0.5rem;
  flex: 1;
  min-height: 560px;
}

.treemap {
  width: 100%;
  height: 620px;
}
</style>
