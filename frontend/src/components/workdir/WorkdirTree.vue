<template>
  <section class="workdir-tree" :aria-label="t('workdir.tree.title')">
    <header class="workdir-tree-header">
      <strong>{{ t('workdir.tree.title') }}</strong>
    </header>
    <p v-if="error" class="workdir-tree-error" role="alert">{{ error }}</p>
    <div
      v-for="row in rows"
      :key="row.path"
      class="workdir-tree-row"
      :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
    >
      <button
        v-if="row.kind === 'directory'"
        class="workdir-tree-entry"
        type="button"
        :aria-expanded="String(expanded.has(row.path))"
        @click="toggle(row.path)"
      >
        <span aria-hidden="true">{{ expanded.has(row.path) ? '▾' : '▸' }}</span>
        <span>{{ row.name }}</span>
      </button>
      <span v-else-if="row.kind === 'metadata'" class="workdir-tree-metadata">
        {{ row.name }} · {{ t('workdir.tree.repositoryMetadata') }}
      </span>
      <button
        v-else
        class="workdir-tree-entry workdir-tree-file"
        :class="{ selected: selected === row.path }"
        type="button"
        @click="select(row.path)"
      >
        <span aria-hidden="true">{{ row.kind === 'link' ? '↪' : '·' }}</span>
        <span>{{ row.name }}</span>
        <small v-if="row.kind === 'link' && row.linkTarget">→ {{ row.linkTarget }}</small>
      </button>
    </div>
    <p v-if="!rows.length && !loading" class="workdir-tree-empty">{{ t('workdir.tree.empty') }}</p>
    <p v-if="loading" class="workdir-tree-empty">{{ t('workdir.tree.loading') }}</p>
  </section>
</template>

<script setup>
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
</script>
