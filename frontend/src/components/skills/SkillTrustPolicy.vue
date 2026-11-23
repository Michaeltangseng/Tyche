<template>
  <article class="settings-card skill-policy-card">
    <div class="settings-card-head">
      <div>
        <h2>{{ t('settingsUi.skillTrust') }}</h2>
        <p>{{ t('settingsUi.trustLead') }}</p>
      </div>
    </div>

    <p v-if="error" class="settings-banner" role="alert">{{ error }}</p>
    <p v-if="!api" class="settings-note">{{ t('settingsUi.skillsUnavailable') }}</p>
    <p v-else-if="loading" class="settings-note">{{ t('common.loading') }}</p>
    <template v-else>
      <div class="skill-policy-row">
        <div>
          <strong>{{ t('settingsUi.policyUntrusted') }}</strong>
          <small>{{ t('settingsUi.policyUntrustedHint') }}</small>
        </div>
        <button class="settings-switch" :class="{ on: policy.untrustedByDefault }" type="button" :disabled="busy" @click="toggle('untrustedByDefault')"><i /></button>
      </div>
      <div class="skill-policy-row">
        <div>
          <strong>{{ t('settingsUi.policyRevoke') }}</strong>
          <small>{{ t('settingsUi.policyRevokeHint') }}</small>
        </div>
        <button class="settings-switch" :class="{ on: policy.revokeOnChange }" type="button" :disabled="busy" @click="toggle('revokeOnChange')"><i /></button>
      </div>
      <div class="skill-policy-row">
        <div>
          <strong>{{ t('settingsUi.policyDenyNetwork') }}</strong>
          <small>{{ t('settingsUi.policyDenyNetworkHint') }}</small>
        </div>
        <button class="settings-switch" :class="{ on: policy.denySkillNetwork }" type="button" :disabled="busy" @click="toggle('denySkillNetwork')"><i /></button>
      </div>
      <div class="skill-policy-summary" :class="{ warn: counts.reauth > 0 }">
        <strong>{{ counts.reauth ? t('settingsUi.policyReauth', { count: counts.reauth }) : t('settingsUi.policyReauthNone') }}</strong>
        <small>{{ t('settingsUi.policyManageHint') }}</small>
      </div>
    </template>
  </article>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { t, translateError } from '../../i18n.js'

const props = defineProps({
  api: { type: Object, default: null },
})

const policy = ref({
  untrustedByDefault: true,
  revokeOnChange: true,
  denySkillNetwork: false,
})
const counts = ref({ reauth: 0 })
const busy = ref(false)
const loading = ref(false)
const error = ref('')

async function load() {
  if (!props.api?.summary) return
  loading.value = true
  error.value = ''
  try {
    const summary = await props.api.summary()
    policy.value = {
      untrustedByDefault: summary?.policy?.untrustedByDefault !== false,
      revokeOnChange: summary?.policy?.revokeOnChange !== false,
      denySkillNetwork: summary?.policy?.denySkillNetwork === true,
    }
    counts.value = summary?.counts || { reauth: 0 }
  } catch (caught) {
    error.value = translateError(caught) || t('settingsUi.errorGeneric')
  } finally {
    loading.value = false
  }
}

async function toggle(key) {
  if (busy.value || !props.api?.updatePolicy) return
  busy.value = true
  error.value = ''
  try {
    await props.api.updatePolicy({ [key]: !policy.value[key] })
    await load()
  } catch (caught) {
    error.value = translateError(caught) || t('settingsUi.errorGeneric')
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.skill-policy-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 52px; border-top: 1px solid var(--border); }
.skill-policy-row:first-of-type { border-top: 0; }
.skill-policy-row > div { display: grid; gap: 3px; }
.skill-policy-row strong { font-size: 13px; }
.skill-policy-row small { color: var(--muted); font-size: 12px; line-height: 1.45; }
.skill-policy-summary { display: grid; gap: 3px; margin-top: 10px; padding: 10px 12px; border-radius: 9px; background: var(--accent-soft); color: var(--accent-text); }
.skill-policy-summary.warn { background: color-mix(in srgb, #f5a524 14%, transparent); color: #f5a524; }
.skill-policy-summary strong { font-size: 12px; }
.skill-policy-summary small { color: var(--muted); font-size: 11px; }
</style>
