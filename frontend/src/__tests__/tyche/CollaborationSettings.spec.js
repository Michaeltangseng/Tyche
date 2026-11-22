import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import CollaborationSettings from '../../components/CollaborationSettings.vue'
import { setLocale } from '../../i18n.js'

describe('collaboration defaults', () => {
  beforeEach(() => {
    localStorage.clear()
    setLocale('en')
  })

  it('stores the wake limit and handoff step limit without claiming they apply yet', async () => {
    const wrapper = mount(CollaborationSettings)
    expect(wrapper.text()).toContain('open chats are unchanged')
    expect(wrapper.get('[aria-label="Wake at most"]').element.value).toBe('1')
    expect(wrapper.get('[aria-label="Maximum handoff steps"]').element.value).toBe('8')

    await wrapper.get('[aria-label="Wake at most"]').setValue('3')
    await wrapper.get('[aria-label="Maximum handoff steps"]').setValue('12')
    await wrapper.get('[aria-label="Wake at most"]').trigger('change')

    expect(JSON.parse(localStorage.getItem('tyche-orchestration-defaults'))).toEqual({
      maxWake: 3,
      maxSteps: 12,
    })
    wrapper.unmount()

    const restored = mount(CollaborationSettings)
    expect(restored.get('[aria-label="Wake at most"]').element.value).toBe('3')
    expect(restored.get('[aria-label="Maximum handoff steps"]').element.value).toBe('12')
    restored.unmount()
  })
})
