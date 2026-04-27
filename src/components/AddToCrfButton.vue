<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessageBox, ElNotification, type Action } from 'element-plus';
import { useCrfStore } from '@/composables/useCrfStore';

// NOTE: prop name is `targetRef`, not `ref`, because in Vue 3 templates the
// `ref` attribute is reserved for template-ref bindings — `:ref="..."` on a
// component registers a template ref on the parent, never gets passed
// through as a prop. Using a different name is the only way to actually
// receive the CDE/bundle key here.
const props = defineProps<{
  kind: 'cde' | 'bundle';
  /** Canonical key — cde_name for CDEs, bundle_name for bundles. */
  targetRef: string | null;
  /** Optional size override for the button. */
  size?: 'small' | 'default' | 'large';
  /** Optional button label override. Default "Add to CRF". Use to clarify
   *  intent when the parent is redirecting the action — e.g. when adding a
   *  bundle from a CDE drawer because the CDE belongs to that bundle. */
  label?: string;
}>();

const router = useRouter();
const { custom, ensureLoaded, createCustomCrf, addItemToCrf } = useCrfStore();

onMounted(() => {
  void ensureLoaded();
});

interface CrfOption {
  id: string;
  title: string;
  alreadyIn: boolean;
  itemCount: number;
}

const options = computed<CrfOption[]>(() => {
  if (!props.targetRef) return [];
  return custom.value.map((c) => ({
    id: c.id,
    title: c.title,
    alreadyIn: c.items.some(
      (it) => it.type === props.kind && it.ref === props.targetRef,
    ),
    itemCount: c.items.length,
  }));
});

async function promptForNewCrfTitle(): Promise<string | null> {
  try {
    const res = await ElMessageBox.prompt('Title for the new CRF', 'New CRF', {
      inputPlaceholder: 'e.g. My PTE Baseline Form',
      confirmButtonText: 'Create',
      cancelButtonText: 'Cancel',
      inputValidator: (v) => (v && v.trim().length ? true : 'Title is required'),
    });
    const typed = (res as { value: string }).value;
    return typed?.trim() || null;
  } catch {
    return null;
  }
}

function notifyAdded(crfId: string, crfTitle: string) {
  ElNotification({
    type: 'success',
    title: 'Added to CRF',
    message: `"${crfTitle}" — click to open`,
    duration: 3000,
    onClick: () => router.push(`/crfs/${crfId}`),
  });
}

function confirmAddDuplicate(crfTitle: string): Promise<boolean> {
  return ElMessageBox.confirm(
    `"${crfTitle}" already contains this ${props.kind}. Add it again?`,
    'Already present',
    { confirmButtonText: 'Add again', cancelButtonText: 'Cancel', type: 'info' },
  )
    .then(() => true)
    .catch((_action: Action) => false);
}

async function handlePick(command: string) {
  if (!props.targetRef) return;

  if (command === '__new__') {
    const title = await promptForNewCrfTitle();
    if (!title) return;
    const crf = createCustomCrf({ title });
    addItemToCrf(crf.id, { type: props.kind, ref: props.targetRef });
    notifyAdded(crf.id, crf.title);
    return;
  }

  const opt = options.value.find((o) => o.id === command);
  if (!opt) return;

  if (opt.alreadyIn) {
    const ok = await confirmAddDuplicate(opt.title);
    if (!ok) return;
  }

  const updated = addItemToCrf(command, { type: props.kind, ref: props.targetRef });
  if (updated) notifyAdded(updated.id, updated.title);
}
</script>

<template>
  <el-dropdown
    trigger="click"
    placement="bottom-end"
    :size="size ?? 'default'"
    @command="handlePick"
  >
    <el-button :size="size ?? 'default'" type="primary" plain>
      <el-icon style="margin-right: 4px"><Plus /></el-icon>
      {{ label ?? 'Add to CRF' }}
      <el-icon style="margin-left: 4px"><ArrowDown /></el-icon>
    </el-button>
    <template #dropdown>
      <el-dropdown-menu>
        <template v-if="options.length">
          <el-dropdown-item
            v-for="opt in options"
            :key="opt.id"
            :command="opt.id"
          >
            <div class="crf-menu-item">
              <span class="crf-menu-item__title">{{ opt.title }}</span>
              <span v-if="opt.alreadyIn" class="crf-menu-item__hint muted">
                already in
              </span>
              <span v-else class="crf-menu-item__hint muted">
                {{ opt.itemCount }} items
              </span>
            </div>
          </el-dropdown-item>
          <el-dropdown-item divided command="__new__">
            <el-icon style="margin-right: 6px"><Plus /></el-icon>
            New CRF…
          </el-dropdown-item>
        </template>
        <el-dropdown-item v-else command="__new__">
          <el-icon style="margin-right: 6px"><Plus /></el-icon>
          New CRF…
          <span class="crf-menu-item__hint muted" style="margin-left: 8px">
            (no custom CRFs yet)
          </span>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>

<style lang="scss" scoped>
.crf-menu-item {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 220px;
  justify-content: space-between;

  &__title {
    font-weight: 500;
    color: $gray_6;
  }

  &__hint {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }
}
</style>
