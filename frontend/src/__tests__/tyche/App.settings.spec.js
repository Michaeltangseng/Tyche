import { readFileSync as readNodeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunTracePanel from '../../components/RunTracePanel.vue'
import { setLocale } from '../../i18n.js'
import { deferred, imageAttachment, mountApp } from './app-test-harness.js'
import { readStylesSource, STYLE_FILES } from './style-test-helpers.js'

function readFileSync(filename, encoding) {
  if (filename === resolve(process.cwd(), 'src/styles.css')) {
    return readStylesSource(filename)
  }
  return readNodeFileSync(filename, encoding)
}

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const originalClipboard = navigator.clipboard
const originalExecCommand = document.execCommand

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('tyche-theme', 'light')
  localStorage.setItem('tyche-onboarding-seen-v1', '1')
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
  setLocale('en')
})

afterEach(() => {
  vi.useRealTimers()
  delete window.tycheDesktop
  document.body.className = ''
  document.body.innerHTML = ''
  if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  else delete HTMLElement.prototype.scrollIntoView
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', { configurable: true, value: originalExecCommand })
  else delete document.execCommand
  vi.restoreAllMocks()
})

describe('Tyche workbench', () => {
  it('renames a running group while its settings remain viewable and locked', async () => {
    const { wrapper, bridge, state, emitWorkspaceChanged } = await mountApp(({ state, bridge }) => {
      state.groups.push({ id: 'running-group', name: 'Research', conversationType: 'group',
        topic: 'Original topic', agentKinds: ['codex', 'hermes'], workdir: '/tmp/research', allowWrite: true })
      state.runningGroupIds = ['running-group']
      state.runs.push({ runId: 'run-1', groupId: 'running-group', phase: 'running', targetKinds: ['codex', 'hermes'], agentRuns: [] })
      bridge.localWorkspace.updateGroup.mockImplementation(async (id, input) => {
        Object.assign(state.groups.find(group => group.id === id), structuredClone(input))
        return structuredClone(state.groups.find(group => group.id === id))
      })
    })
    await wrapper.get('.conversation-link').trigger('click')
    await wrapper.get('.conversation-title-button').trigger('click')
    await wrapper.get('.inline-title-form input').setValue('Live research')
    await wrapper.get('.inline-title-form').trigger('submit')
    await flushPromises()
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledWith('running-group', { name: 'Live research' })
    expect(state.groups[0]).toMatchObject({ name: 'Live research', topic: 'Original topic', workdir: '/tmp/research', allowWrite: true, agentKinds: ['codex', 'hermes'] })
    expect(state.runningGroupIds).toEqual(['running-group'])
    await wrapper.get('.conversation-header-actions .icon-button').trigger('click')
    const form = wrapper.get('.settings-form')
    expect(form.text()).toContain('Other settings are read-only')
    expect(form.findAll('.settings-primary-grid input').every(input => input.element.disabled)).toBe(true)
    expect(form.get('fieldset').element.disabled).toBe(true)
    expect(form.get('.switch-row input').element.disabled).toBe(true)
    expect(form.get('.input-action-row button').element.disabled).toBe(true)
    expect(form.get('.settings-delete-trigger').element.disabled).toBe(true)
    expect(form.get('button[type="submit"]').element.disabled).toBe(true)
    await form.trigger('submit')
    expect(bridge.localWorkspace.updateGroup).toHaveBeenCalledTimes(1)
    state.runningGroupIds = []
    state.runs = []
    emitWorkspaceChanged()
    await flushPromises()
    expect(form.get('fieldset').element.disabled).toBe(false)
    expect(form.get('button[type="submit"]').element.disabled).toBe(false)
    wrapper.unmount()
  })

  it('shows a compact DeepSeek card without setup information', async () => {
    const { wrapper } = await mountApp()
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await flushPromises()
    const card = wrapper.findAll('.settings-agent-card').find(item => item.text().includes('DeepSeek Harness'))
    expect(card).toBeTruthy()
    expect(card.get('img').attributes('src')).toBe('./agent-logos/deepseek.png')
    expect(card.find('details').exists()).toBe(false)
    expect(card.find('.agent-state').exists()).toBe(true)
    expect(card.find('.settings-agent-actions').exists()).toBe(true)
    expect(card.text()).not.toContain('ZGCI_API_KEY')
    wrapper.unmount()
  })
  it('keeps one settings navigation shell across all tabs without a visible title block', async () => {
    const { wrapper } = await mountApp()
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    const body = wrapper.get('.system-settings-body').element
    const navigation = wrapper.get('.settings-tabs').element
    for (const index of [0, 1, 2, 3, 0]) {
      await wrapper.findAll('.settings-tabs button')[index].trigger('click')
      await flushPromises()
      expect(wrapper.get('.system-settings-body').element).toBe(body)
      expect(wrapper.get('.settings-tabs').element).toBe(navigation)
      expect(wrapper.find('.system-settings-header').exists()).toBe(false)
      expect(wrapper.findAll('.settings-tabs [aria-selected="true"]')).toHaveLength(1)
      expect(wrapper.findAll('.settings-tabs button')[index].attributes('aria-selected')).toBe('true')
    }
    wrapper.unmount()
  })
  it('shows the agent management shell and leaves the other settings pages blank', async () => {
    const { wrapper } = await mountApp()

    await wrapper.get('.sidebar-settings-entry').trigger('click')
    expect(wrapper.get('.settings-agent-page').text()).toContain('Agent management')
    expect(wrapper.find('.cloud-empty-card').exists()).toBe(true)
    expect(wrapper.find('.knowledge-base-panel').exists()).toBe(false)
    await wrapper.findAll('.settings-tabs button')[1].trigger('click')
    expect(wrapper.find('.settings-agent-page').exists()).toBe(false)
    expect(wrapper.get('.settings-blank').exists()).toBe(true)
    wrapper.unmount()
  })

  it('enables onboarding completion as soon as Agent detection finishes on any slide', async () => {
    vi.useFakeTimers()
    localStorage.removeItem('tyche-onboarding-seen-v1')
    let finishDetection
    const pendingDetection = new Promise(resolve => { finishDetection = resolve })
    const { wrapper, state } = await mountApp(({ bridge }) => {
      bridge.localWorkspace.refreshAgents.mockReturnValueOnce(pendingDetection)
    })

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(wrapper.get('.agent-discovery-overlay').find('.wave-physics-loader').exists()).toBe(true)
    expect(wrapper.get('.sidebar').attributes()).toHaveProperty('inert')
    expect(wrapper.get('.workspace-pane').attributes()).toHaveProperty('inert')

    finishDetection(structuredClone(state))
    await flushPromises()

    expect(wrapper.find('.agent-discovery-overlay').exists()).toBe(false)
    expect(wrapper.get('.onboarding-dialog').attributes('aria-modal')).toBe('true')
    expect(wrapper.findAll('.onboarding-dot')).toHaveLength(5)
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('discover-local-agents-tyche.png')
    expect(document.activeElement).toBe(wrapper.get('.onboarding-dialog').element)
    expect(wrapper.get('.onboarding-primary').attributes()).not.toHaveProperty('disabled')
    expect(wrapper.get('.onboarding-primary').text()).toContain('Get started')

    await wrapper.findAll('.onboarding-dot')[1].trigger('click')

    await vi.advanceTimersByTimeAsync(3_200)
    await flushPromises()
    expect(wrapper.get('.onboarding-slide img').attributes('src')).toContain('skills-and-images.png')

    await wrapper.get('.onboarding-primary').trigger('click')
    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('tyche-onboarding-seen-v1')).toBe('1')
    expect(wrapper.get('.sidebar').attributes()).not.toHaveProperty('inert')
    wrapper.unmount()
  })

  it('wraps keyboard focus within the onboarding dialog in both directions', async () => {
    localStorage.removeItem('tyche-onboarding-seen-v1')
    const { wrapper } = await mountApp()
    const dialog = wrapper.get('.onboarding-dialog')
    const focusable = dialog.findAll('button:not([disabled])')
    const first = focusable[0].element
    const last = focusable[focusable.length - 1].element

    last.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    }))
    expect(document.activeElement).toBe(first)

    first.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }))
    expect(document.activeElement).toBe(last)

    wrapper.unmount()
  })

  it('loads every stylesheet partition from the real entrypoint in stable order', () => {
    const entry = readNodeFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    expect(entry).toEqual(STYLE_FILES.map(file => `@import './styles/${file}';`))
  })

  it('keeps the onboarding frame stable with faster transitions and no internal dividers', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    const onboardingSource = readFileSync(
      resolve(process.cwd(), 'src/composables/useOnboarding.js'),
      'utf8',
    )

    expect(onboardingSource).toContain('const ONBOARDING_SLIDE_MS = 3200')
    expect(onboardingSource).toContain('const onboardingReady = computed(() => !onboardingDetecting.value)')
    expect(source).toMatch(/\.onboarding-dialog\s*\{[^}]*height:\s*min\(700px, calc\(100dvh - 48px\)\);/s)
    expect(source).toMatch(/\.onboarding-slide-viewport\s*\{[^}]*position:\s*relative;[^}]*overflow:\s*hidden;/s)
    expect(source).toMatch(/\.onboarding-slide\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*grid-template-rows:\s*minmax\(0, 1fr\) 148px;/s)
    expect(source).toMatch(/\.onboarding-slide > img\s*\{[^}]*height:\s*100%;[^}]*border-bottom:\s*0;/s)
    expect(source).toMatch(/\.onboarding-footer\s*\{[^}]*border-top:\s*0;/s)
    expect(source).toMatch(/\.onboarding-slide-enter-active,[^{]+\{[^}]*transition:\s*opacity 0\.1s ease;/s)
  })

  it('dismisses first-run onboarding with Escape and releases the body scroll lock', async () => {
    localStorage.removeItem('tyche-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('tyche-onboarding-seen-v1')).toBe('1')
    expect(historyBack).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('dismisses first-run onboarding with browser back without navigating twice', async () => {
    localStorage.removeItem('tyche-onboarding-seen-v1')
    const historyBack = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { wrapper } = await mountApp()

    expect(document.body.classList.contains('modal-open')).toBe(true)
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flushPromises()

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(document.body.classList.contains('modal-open')).toBe(false)
    expect(localStorage.getItem('tyche-onboarding-seen-v1')).toBe('1')
    expect(historyBack).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('does not cover an existing workspace when the onboarding marker is missing', async () => {
    localStorage.removeItem('tyche-onboarding-seen-v1')
    const { wrapper, bridge } = await mountApp(({ state }) => {
      state.groups.push({
        id: 'existing-group',
        name: 'Existing workspace',
        topic: '',
        agentKinds: ['codex', 'hermes'],
        workdir: '/tmp/tyche-workspace',
        allowWrite: false,
        createdAt: '2026-07-29T08:00:00Z',
        updatedAt: '2026-07-29T08:00:00Z',
      })
    })

    expect(wrapper.find('.onboarding-dialog').exists()).toBe(false)
    expect(localStorage.getItem('tyche-onboarding-seen-v1')).toBe('1')
    expect(bridge.localWorkspace.refreshAgents).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('does not host knowledge sources inside settings', async () => {
    const { wrapper } = await mountApp()
    await wrapper.get('.sidebar-settings-entry').trigger('click')
    await flushPromises()
    expect(wrapper.find('.knowledge-base-panel').exists()).toBe(false)
    expect(wrapper.get('.settings-agent-page').exists()).toBe(true)
    wrapper.unmount()
  })

  it('shows local knowledge sources and can pick an Obsidian vault', async () => {
    const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')
    expect(styles).toMatch(/\.knowledge-base-toolbar\s*\{/s)
    expect(styles).toMatch(/\.knowledge-base-list,\s*\.knowledge-base-future-list\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/s)
    expect(styles).toMatch(/\.knowledge-base-item\s*,\s*\.knowledge-base-future-item\s*\{[^}]*border:\s*0;[^}]*background:\s*color-mix/s)
    expect(styles).toMatch(/\.knowledge-base-item-main\s*\{[^}]*grid-template-columns:\s*48px minmax\(0, 1fr\);/s)
    expect(styles).toMatch(/\.knowledge-base-tag-row\s*\{[^}]*flex-wrap:\s*wrap;/s)
    expect(styles).toMatch(/\.knowledge-base-tag\s*\{[^}]*border-radius:\s*4px;/s)
    expect(styles).toMatch(/\.knowledge-base-future-item\s*\{[^}]*pointer-events:\s*none;/s)
    for (const [filename, source] of [
      ['feishu.svg', 'https://open.feishu.cn/'],
      ['dingtalk.svg', 'https://www.dingtalk.com/'],
      ['obsidian.svg', 'https://obsidian.md/brand'],
    ]) {
      expect(readFileSync(resolve(process.cwd(), `public/knowledge-base-logos/${filename}`), 'utf8')).toContain(`Source: ${source}`)
    }
  })
})
