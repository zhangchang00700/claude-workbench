// 桌面宠物渲染层：程序化 SVG 吉祥物 + stream:event 状态驱动，纯显示组件
import type { ChatEvent, StreamEvent } from '../shared/preload-api'
import { createMascot, type MascotState } from './mascotScene'

const stage = document.getElementById('stage') as HTMLDivElement
const closeBtn = document.getElementById('close') as HTMLButtonElement

const scene = createMascot()
stage.appendChild(scene.svg)
scene.setState('idle')

let base: MascotState = 'idle'
let flash: MascotState | null = null
let flashUntil = 0

function apply(): void {
  const st: MascotState = flash && Date.now() < flashUntil ? flash : base
  scene.setState(st)
}

function flashFor(s: 'done' | 'error'): void {
  flash = s
  flashUntil = Date.now() + 4000
  base = 'idle' // 闪态结束后回落到待命，而不是弹回上一次的 busy
  apply()
  setTimeout(() => {
    flash = null
    apply()
  }, 4100)
}

window.workbench.onStreamEvent((e: StreamEvent) => {
  if (e.domain !== 'chat') return
  const ev = e.payload as ChatEvent
  if (ev.type === 'start' || ev.type === 'delta' || ev.type === 'tool') base = 'busy'
  else if (ev.type === 'done') flashFor('done')
  else if (ev.type === 'error') flashFor('error')
})

closeBtn.addEventListener('click', () => window.close())
apply()

// 调试探针（CDP 验证用）
;(window as unknown as { __petState: () => object }).__petState = () => ({
  base,
  flash,
  msLeft: flash ? flashUntil - Date.now() : 0,
})
