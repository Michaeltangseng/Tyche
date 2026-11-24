<template>
  <span
    ref="root"
    class="room-mascot-art"
    aria-hidden="true"
    v-html="markup"
    @pointermove="followEyes"
    @pointerleave="resetEyes"
  />
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import blob01 from '../../public/room-mascots/blob-01.svg?raw'
import blob02 from '../../public/room-mascots/blob-02.svg?raw'
import blob03 from '../../public/room-mascots/blob-03.svg?raw'
import blob04 from '../../public/room-mascots/blob-04.svg?raw'
import blob05 from '../../public/room-mascots/blob-05.svg?raw'
import blob06 from '../../public/room-mascots/blob-06.svg?raw'
import blob07 from '../../public/room-mascots/blob-07.svg?raw'
import blob08 from '../../public/room-mascots/blob-08.svg?raw'
import blob09 from '../../public/room-mascots/blob-09.svg?raw'
import blob10 from '../../public/room-mascots/blob-10.svg?raw'
import blob11 from '../../public/room-mascots/blob-11.svg?raw'
import blob12 from '../../public/room-mascots/blob-12.svg?raw'

const ART = Object.freeze({
  '01': blob01,
  '02': blob02,
  '03': blob03,
  '04': blob04,
  '05': blob05,
  '06': blob06,
  '07': blob07,
  '08': blob08,
  '09': blob09,
  '10': blob10,
  '11': blob11,
  '12': blob12,
})

const ACTION_CLASSES = ['is-blinking', 'look-left', 'look-right', 'is-squinting']

const props = defineProps({
  mascot: { type: Object, required: true },
})

let nextTimer = 0
let actionTimer = 0

const root = ref(null)
const instance = useId()

const markup = computed(() => {
  const id = String(props.mascot?.id || '')
  const raw = ART[id]
  if (!raw) return ''
  return raw
    .replace(/<style>[\s\S]*?<\/style>/, '')
    .replaceAll(`blob-${id}-grad`, `blob-${id}-rm${instance}-grad`)
})

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

function clearAction() {
  if (actionTimer) window.clearTimeout(actionTimer)
  actionTimer = 0
  root.value?.classList.remove(...ACTION_CLASSES)
}

function scheduleNext(delay) {
  if (nextTimer) window.clearTimeout(nextTimer)
  nextTimer = window.setTimeout(runAction, delay)
}

function runAction() {
  nextTimer = 0
  const art = root.value
  if (!art) return
  if (!document.hidden && !prefersReducedMotion()) {
    clearAction()
    const roll = Math.random()
    if (roll < 0.45) {
      art.classList.add('is-blinking')
      actionTimer = window.setTimeout(() => {
        art.classList.remove('is-blinking')
        actionTimer = 0
      }, 170)
    } else {
      const action = roll < 0.70 ? 'look-left' : roll < 0.90 ? 'look-right' : 'is-squinting'
      art.classList.add(action)
      actionTimer = window.setTimeout(() => {
        art.classList.remove(action)
        actionTimer = 0
      }, 600 + Math.random() * 400)
    }
  }
  scheduleNext(1000 + Math.random() * 1800)
}

function followEyes(event) {
  if (prefersReducedMotion()) return
  const art = root.value
  const svg = art?.querySelector('svg')
  const eyes = art?.querySelector('.eyes')
  if (!svg || !eyes) return
  const rect = svg.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const dx = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)))
  const dy = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)))
  eyes.style.transform = `translate(${(dx * 4).toFixed(2)}px, ${(dy * 2.5).toFixed(2)}px)`
}

function resetEyes() {
  const eyes = root.value?.querySelector('.eyes')
  if (eyes) eyes.style.transform = ''
}

onMounted(() => {
  if (prefersReducedMotion()) return
  scheduleNext(400 + Math.random() * 900)
})

onBeforeUnmount(() => {
  if (nextTimer) window.clearTimeout(nextTimer)
  if (actionTimer) window.clearTimeout(actionTimer)
})
</script>
