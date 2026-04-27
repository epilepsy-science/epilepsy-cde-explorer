<script setup lang="ts">
// New-custom-CRF dialog. Used from the CRFs list (header + empty state) and
// can be reused anywhere a "Create CRF" entry point is needed. Emits the new
// CRF's id on success so the caller can navigate.
import { ref, watch } from 'vue';
import { useCrfStore } from '@/composables/useCrfStore';

const props = defineProps<{
  modelValue: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  created: [crfId: string];
}>();

const { createCustomCrf, updateCustomCrf } = useCrfStore();

const title = ref('');
const description = ref('');
const studyType = ref<'' | 'Clinical' | 'Preclinical'>('');
const diseaseScope = ref('');
const submitting = ref(false);
const error = ref<string | null>(null);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      title.value = '';
      description.value = '';
      studyType.value = '';
      diseaseScope.value = '';
      error.value = null;
    }
  },
);

function close() {
  emit('update:modelValue', false);
}

function submit() {
  const t = title.value.trim();
  if (!t) {
    error.value = 'Title is required.';
    return;
  }
  submitting.value = true;
  try {
    const crf = createCustomCrf({
      title: t,
      description: description.value.trim() || null,
      disease_scope: diseaseScope.value.trim() || null,
    });
    if (studyType.value) {
      updateCustomCrf(crf.id, { study_type: studyType.value });
    }
    emit('created', crf.id);
    emit('update:modelValue', false);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    title="Create a custom CRF"
    width="520px"
    align-center
  >
    <p class="dialog-lede subtle">
      Group CDEs into your own data-collection form. You can rename, reorder,
      and remove items after creating it.
    </p>

    <el-alert
      type="info"
      :closable="false"
      show-icon
      class="dialog-notice"
    >
      <template #title>Heads up — early feature</template>
      <ul class="dialog-notice__list">
        <li>You can only assemble CRFs from CDEs already in our library — defining brand-new CDEs isn't supported yet.</li>
        <li>Custom CRFs are saved in your browser's local storage on this machine, so they won't follow you to other devices or browsers.</li>
        <li>This will evolve — expect richer authoring (custom fields, sharing, server-backed storage) as part of Pennsieve in future releases.</li>
      </ul>
    </el-alert>

    <el-form label-position="top" @submit.prevent="submit">
      <el-form-item label="Title" required>
        <el-input
          v-model="title"
          placeholder="e.g. Baseline visit — TBI cohort"
          maxlength="200"
          autofocus
          @keydown.enter.exact.prevent="submit"
        />
      </el-form-item>

      <el-form-item label="Description (optional)">
        <el-input
          v-model="description"
          type="textarea"
          :rows="2"
          placeholder="What this form is for, when it's collected, etc."
          maxlength="2000"
          show-word-limit
        />
      </el-form-item>

      <div class="dialog-row">
        <el-form-item label="Study type" class="dialog-row__item">
          <el-radio-group v-model="studyType" size="default">
            <el-radio-button value="">Either</el-radio-button>
            <el-radio-button value="Clinical">Clinical</el-radio-button>
            <el-radio-button value="Preclinical">Preclinical</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item label="Disease scope (optional)" class="dialog-row__item">
          <el-input
            v-model="diseaseScope"
            placeholder="e.g. PTE, TBI"
            maxlength="120"
          />
        </el-form-item>
      </div>

      <p v-if="error" class="dialog-error">{{ error }}</p>
    </el-form>

    <template #footer>
      <el-button @click="close">Cancel</el-button>
      <el-button type="primary" :loading="submitting" @click="submit">
        Create
      </el-button>
    </template>
  </el-dialog>
</template>

<style lang="scss" scoped>
.dialog-lede {
  margin-top: -8px;
  margin-bottom: 12px;
  font-size: 13px;
}

.dialog-notice {
  margin-bottom: 16px;

  &__list {
    margin: 4px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.5;

    li + li {
      margin-top: 2px;
    }
  }
}

.dialog-row {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;

  &__item {
    flex: 1 1 180px;
    min-width: 180px;
  }
}

.dialog-error {
  margin: 0;
  font-size: 13px;
  color: #b91c1c;
}
</style>
