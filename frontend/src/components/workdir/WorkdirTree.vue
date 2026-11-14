<template>
  <section class="workdir-tree" :aria-label="t('workdir.tree.title')">
    <header class="workdir-tree-header">
      <strong>{{ t('workdir.tree.title') }}</strong>
      <small v-if="rows.length">{{ rows.length }}</small>
    </header>
    <label class="workdir-tree-search">
      <SearchOutline aria-hidden="true" />
      <input
        v-model="query"
        type="search"
        :placeholder="t('workdir.tree.search')"
        :aria-label="t('workdir.tree.search')"
      />
      <button
        v-if="query"
        type="button"
        :title="t('workdir.tree.clearSearch')"
        :aria-label="t('workdir.tree.clearSearch')"
        @click="query = ''"
      >
        <CloseCircleOutline aria-hidden="true" />
      </button>
    </label>
    <p v-if="error" class="workdir-tree-error" role="alert">{{ error }}</p>
    <div
      v-for="row in filteredRows"
      :key="row.path"
      class="workdir-tree-row"
      :style="{ paddingLeft: `${6 + row.depth * 13}px` }"
    >
      <button
        v-if="row.kind === 'directory'"
        class="workdir-tree-entry"
        type="button"
        :aria-expanded="String(expanded.has(row.path))"
        @click="toggle(row.path)"
      >
        <ChevronDownOutline v-if="expanded.has(row.path)" class="workdir-tree-chevron" aria-hidden="true" />
        <ChevronForwardOutline v-else class="workdir-tree-chevron" aria-hidden="true" />
        <FolderOpenOutline v-if="expanded.has(row.path)" class="workdir-tree-icon folder" aria-hidden="true" />
        <FolderOutline v-else class="workdir-tree-icon folder" aria-hidden="true" />
        <span class="workdir-tree-name">{{ row.name }}</span>
      </button>
      <span v-else-if="row.kind === 'metadata'" class="workdir-tree-metadata">
        <LockClosedOutline aria-hidden="true" />
        <span>{{ row.name }}</span>
        <small>{{ t('workdir.tree.repositoryMetadata') }}</small>
      </span>
      <button
        v-else
        class="workdir-tree-entry workdir-tree-file"
        :class="{ selected: selected === row.path }"
        type="button"
        :title="row.path"
        @click="select(row.path)"
      >
        <component :is="rowIcon(row)" class="workdir-tree-icon" aria-hidden="true" />
        <span class="workdir-tree-name">{{ row.name }}</span>
        <small v-if="row.kind === 'link' && row.linkTarget">→ {{ row.linkTarget }}</small>
      </button>
    </div>
    <p v-if="!rows.length && !loading" class="workdir-tree-empty">{{ t('workdir.tree.empty') }}</p>
    <p v-else-if="query && !filteredRows.length" class="workdir-tree-empty">
      {{ t('workdir.tree.noMatches') }}
    </p>
    <p v-if="loading" class="workdir-tree-empty">{{ t('workdir.tree.loading') }}</p>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import {
  ChevronDownOutline,
  ChevronForwardOutline,
  CloseCircleOutline,
  CodeSlashOutline,
  DocumentOutline,
  DocumentTextOutline,
  FolderOpenOutline,
  FolderOutline,
  ImageOutline,
  LinkOutline,
  LockClosedOutline,
  SearchOutline,
} from '@vicons/ionicons5'

const props = defineProps({
  controller: { type: Object, required: true },
})

const {
  error,
  expanded,
  loading,
  rows,
  select,
  selected,
  t,
  toggle,
} = props.controller

const query = ref('')
const filteredRows = computed(() => {
  const needle = query.value.trim().toLowerCase()
  if (!needle) return rows.value
  return rows.value.filter(row => (
    String(row.name || '').toLowerCase().includes(needle)
    || String(row.path || '').toLowerCase().includes(needle)
  ))
})

const CODE_EXTENSIONS = new Set([
  'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'vue', 'css', 'scss', 'less',
  'html', 'json', 'yml', 'yaml', 'toml', 'sh', 'zsh', 'py', 'rb', 'go',
  'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'sql',
])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'])

function rowIcon(row) {
  if (row.kind === 'link') return LinkOutline
  const extension = String(row.name || '').split('.').at(-1).toLowerCase()
  if (IMPORTANT_TEXT_EXTENSIONS.has(extension)) return DocumentTextOutline
  if (CODE_EXTENSIONS.has(extension)) return CodeSlashOutline
  if (IMAGE_EXTENSIONS.has(extension)) return ImageOutline
  return DocumentOutline
}

const IMPORTANT_TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'log'])
</script>
