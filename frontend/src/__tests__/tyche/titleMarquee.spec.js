import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import SettingsPages from '../../components/SettingsPages.vue'
import { setLocale } from '../../i18n.js'
import { readTitleMarqueeEnabled, setTitleMarqueeEnabled, titleMarqueeEnabled } from '../../title-marquee.js'

beforeEach(() => {
  setTitleMarqueeEnabled(true)
  setLocale('en')
})

describe('chat title marquee preference', () => {
  it('scrolls long names unless the preference is turned off', () => {
    expect(readTitleMarqueeEnabled()).toBe(true)
    setTitleMarqueeEnabled(false)
    expect(readTitleMarqueeEnabled()).toBe(false)
    expect(titleMarqueeEnabled.value).toBe(false)
    setTitleMarqueeEnabled(true)
    expect(readTitleMarqueeEnabled()).toBe(true)
  })

  it('saves the personal preference switch', async () => {
    const wrapper = mount(SettingsPages, {
      props: {
        section: 'preferences',
        setThemePreference: () => {},
        themePreference: 'dark',
        installedAgentKinds: [],
      },
    })
    await flushPromises()
    const toggle = wrapper.get('[role="switch"][aria-label="Scroll long chat names"]')
    expect(toggle.attributes('aria-checked')).toBe('true')
    await toggle.trigger('click')
    expect(toggle.attributes('aria-checked')).toBe('false')
    expect(readTitleMarqueeEnabled()).toBe(false)
    wrapper.unmount()
  })
})
