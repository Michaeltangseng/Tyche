import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RoomMascot from '../../components/RoomMascot.vue'
import { ROOM_MASCOTS } from '../../room-mascots.js'

describe('RoomMascot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('inlines the mascot SVG with instance-scoped gradients and no standalone styles', () => {
    const Pair = defineComponent({
      components: { RoomMascot },
      setup: () => ({ mascot: ROOM_MASCOTS[1] }),
      template: '<div><RoomMascot :mascot="mascot" /><RoomMascot :mascot="mascot" /></div>',
    })
    const wrapper = mount(Pair)
    const [firstArt, secondArt] = wrapper.findAll('.room-mascot-art')

    expect(firstArt.find('svg').exists()).toBe(true)
    expect(firstArt.html()).not.toContain('<style')
    const firstGradient = firstArt.element.querySelector('[id^="blob-02"]')?.id
    const secondGradient = secondArt.element.querySelector('[id^="blob-02"]')?.id
    expect(firstGradient).toContain('blob-02')
    expect(firstGradient).not.toBe(secondGradient)
    expect(firstArt.html()).toContain(`url(#${firstGradient})`)

    wrapper.unmount()
  })

  it('plays random blink and gaze actions on its own timer', async () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0)
    const wrapper = mount(RoomMascot, { props: { mascot: ROOM_MASCOTS[0] } })

    expect(wrapper.classes()).not.toContain('is-blinking')
    await vi.advanceTimersByTimeAsync(400)
    expect(wrapper.classes()).toContain('is-blinking')
    await vi.advanceTimersByTimeAsync(170)
    expect(wrapper.classes()).not.toContain('is-blinking')

    random.mockReturnValue(0.6)
    await vi.advanceTimersByTimeAsync(1000)
    expect(wrapper.classes()).toContain('look-left')
    await vi.advanceTimersByTimeAsync(840)
    expect(wrapper.classes()).not.toContain('look-left')

    wrapper.unmount()
  })
})
