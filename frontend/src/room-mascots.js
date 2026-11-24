import { publicAsset } from './catalog.js'

// One animated mascot per room. Each SVG carries its own blink animation, so
// it keeps moving when the sidebar references it as an <img>.
export const ROOM_MASCOTS = Object.freeze([
  { id: '01', name: '年糕', src: publicAsset('room-mascots/blob-01.svg') },
  { id: '02', name: '腰豆', src: publicAsset('room-mascots/blob-02.svg') },
  { id: '03', name: '叶子鹅卵石', src: publicAsset('room-mascots/blob-03.svg') },
  { id: '04', name: '软方块', src: publicAsset('room-mascots/blob-04.svg') },
  { id: '05', name: '月牙', src: publicAsset('room-mascots/blob-05.svg') },
  { id: '06', name: '圆环', src: publicAsset('room-mascots/blob-06.svg') },
  { id: '07', name: '水滴糖', src: publicAsset('room-mascots/blob-07.svg') },
  { id: '08', name: '苜蓿', src: publicAsset('room-mascots/blob-08.svg') },
  { id: '09', name: '螺旋面包', src: publicAsset('room-mascots/blob-09.svg') },
  { id: '10', name: '水洼', src: publicAsset('room-mascots/blob-10.svg') },
  { id: '11', name: '花生', src: publicAsset('room-mascots/blob-11.svg') },
  { id: '12', name: '四角星', src: publicAsset('room-mascots/blob-12.svg') },
])

export function roomMascot(room) {
  const key = String(room?.id ?? room?.name ?? '')
  let hash = 0
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) >>> 0
  }
  return ROOM_MASCOTS[hash % ROOM_MASCOTS.length]
}
