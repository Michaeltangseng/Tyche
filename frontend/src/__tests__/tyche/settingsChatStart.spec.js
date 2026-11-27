import { mount, flushPromises } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SettingsPages from '../../components/SettingsPages.vue'
import { setLocale } from '../../i18n.js'
import { applyRoomRunPreferences } from '../../room-run-preferences.js'

afterEach(() => {
  delete window.tycheDesktop
  applyRoomRunPreferences({ openWorkbenchOnStart: true, rosterWaitsForInstruction: true, userPortrait: '' })
})

describe('chat start preferences', () => {
  it('keeps the agent logo on the detail dialog and saves a multi-member start', async () => {
    setLocale('en')
    const save = vi.fn(async value => value)
    window.tycheDesktop = {
      workPreferences: {
        get: vi.fn(async () => ({
          detail: 50,
          initiative: 50,
          evidence: 50,
          preferredAgentKinds: [],
          instructions: '',
          chatStartMode: 'single',
          defaultCaptainKind: 'claude',
          defaultMemberKinds: ['claude'],
        })),
        save,
      },
    }
    const openAgentDetail = vi.fn()
    const wrapper = mount(SettingsPages, {
      props: {
        section: 'preferences',
        setThemePreference: () => {},
        themePreference: 'dark',
        installedAgentKinds: ['codex', 'claude'],
        openAgentDetail,
      },
    })
    await flushPromises()

    const claude = wrapper.findAll('.pref-member').find(row => row.text().includes('Claude Code'))
    await claude.get('.pref-member-logo').trigger('click')
    expect(openAgentDetail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' }))
    expect(save).not.toHaveBeenCalled()

    const multi = wrapper.findAll('button').find(button => button.text() === 'Multiple')
    await multi.trigger('click')
    const codex = wrapper.findAll('.pref-member').find(row => row.text().includes('Codex'))
    await codex.get('.pref-member-name').trigger('click')
    expect(save).not.toHaveBeenCalled()

    const wait = wrapper.findAll('[role="switch"]').find(button => button.attributes('aria-label') === 'Wait for an instruction when someone joins')
    expect(wait.attributes('aria-checked')).toBe('true')
    await wait.trigger('click')
    await wrapper.get('button.primary-button').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      chatStartMode: 'multi',
      defaultCaptainKind: 'claude',
      defaultMemberKinds: ['claude', 'codex'],
      rosterWaitsForInstruction: false,
    }))

    expect(wrapper.get('[role="radiogroup"] [role="radio"][aria-checked="true"]').text()).toBe('Multiple')
    expect(wrapper.findAll('[role="radiogroup"] [role="radio"][aria-checked="true"]')).toHaveLength(1)
    wrapper.unmount()
  })

  it('leaves the other switch alone while one preference is saving', async () => {
    setLocale('en')
    const save = vi.fn(async value => value)
    window.tycheDesktop = {
      workPreferences: {
        get: vi.fn(async () => ({
          openWorkbenchOnStart: true,
          rosterWaitsForInstruction: true,
          userPortrait: '',
          chatStartMode: 'single',
          defaultCaptainKind: 'claude',
          defaultMemberKinds: ['claude'],
        })),
        save,
      },
    }
    const wrapper = mount(SettingsPages, {
      props: {
        section: 'preferences',
        setThemePreference: () => {},
        themePreference: 'dark',
        installedAgentKinds: ['claude'],
      },
    })
    await flushPromises()
    const workbench = wrapper.get('[role="switch"][aria-label="Open the workbench when work starts"]')
    const wait = wrapper.get('[role="switch"][aria-label="Wait for an instruction when someone joins"]')
    await wait.trigger('click')
    expect(save).not.toHaveBeenCalled()
    expect(wait.attributes('aria-checked')).toBe('false')
    expect(workbench.attributes('aria-checked')).toBe('true')
    await wrapper.get('button.secondary-button').trigger('click')
    expect(wait.attributes('aria-checked')).toBe('true')
    expect(workbench.attributes('aria-checked')).toBe('true')
    await wait.trigger('click')
    await wrapper.get('button.primary-button').trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      rosterWaitsForInstruction: false,
      openWorkbenchOnStart: true,
    }))
    wrapper.unmount()
  })
})
