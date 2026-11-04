// mascotScene.ts - 程序化 SVG 吉祥物装配体：纯代码绘制与动画，零视频/贴图依赖
// 状态机: idle(呼吸眨眼) / busy(敲键盘) / done(挥手庆祝) / error(告警抖动)
// 框架无关：React 面板与桌宠 vanilla 页共用同一套 createMascot()

export type MascotState = 'idle' | 'busy' | 'done' | 'error'

const NS = 'http://www.w3.org/2000/svg'

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
  parent?: Element
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  if (parent) parent.appendChild(node)
  return node
}

export interface MascotScene {
  svg: SVGSVGElement
  setState(s: MascotState): void
  destroy(): void
}

export function createMascot(): MascotScene {
  const svg = el('svg', { viewBox: '0 0 200 190', xmlns: NS })
  svg.style.width = '100%'
  svg.style.height = 'auto'
  svg.style.display = 'block'
  svg.style.overflow = 'visible'

  // ---- defs: 渐变与滤镜 ----
  const defs = el('defs', {}, svg)
  const bodyGrad = el('radialGradient', { id: 'm-body', cx: '0.35', cy: '0.28', r: '1.1' }, defs)
  el('stop', { offset: '0', 'stop-color': '#ffffff' }, bodyGrad)
  el('stop', { offset: '1', 'stop-color': '#dfe7ef' }, bodyGrad)
  const screenGrad = el('linearGradient', { id: 'm-screen', x1: '0', y1: '0', x2: '0', y2: '1' }, defs)
  el('stop', { offset: '0', 'stop-color': '#232d3b' }, screenGrad)
  el('stop', { offset: '1', 'stop-color': '#0a0f16' }, screenGrad)
  const orangeGrad = el('linearGradient', { id: 'm-orange', x1: '0', y1: '0', x2: '0', y2: '1' }, defs)
  el('stop', { offset: '0', 'stop-color': '#f59e42' }, orangeGrad)
  el('stop', { offset: '1', 'stop-color': '#d96f14' }, orangeGrad)
  const glow = el('filter', { id: 'm-glow', x: '-80%', y: '-80%', width: '260%', height: '260%' }, defs)
  el('feGaussianBlur', { stdDeviation: '2.6', result: 'b' }, glow)
  const merge = el('feMerge', {}, glow)
  el('feMergeNode', { in: 'b' }, merge)
  el('feMergeNode', { in: 'SourceGraphic' }, merge)

  // ---- 接地阴影（不随身体浮动） ----
  const shadow = el('ellipse', { cx: 100, cy: 176, rx: 44, ry: 6.5, fill: '#05080c', opacity: 0.2 }, svg)

  // ---- 悬浮身体组 ----
  const gBob = el('g', {}, svg)

  // 天线
  el('rect', { x: 98.8, y: 5, width: 2.4, height: 16, rx: 1.2, fill: '#98a4b3' }, gBob)
  const ball = el('circle', { cx: 100, cy: 4.2, r: 4.6, fill: '#f6a12d' }, gBob)

  // 头组（轻微点头/歪头）
  const gHead = el('g', {}, gBob)
  // 耳罩
  for (const [cx, cy] of [[34, 51], [166, 51]] as const) {
    el('circle', { cx, cy, r: 11, fill: 'url(#m-orange)' }, gHead)
    el('circle', { cx, cy, r: 5.5, fill: '#b25f10' }, gHead)
  }
  // 头壳
  el('rect', { x: 34, y: 18, width: 132, height: 66, rx: 28, fill: 'url(#m-body)', stroke: '#cfd8e1', 'stroke-width': 1 }, gHead)
  // 屏幕玻璃
  const screenClip = el('clipPath', { id: 'm-screen-clip' }, defs)
  el('rect', { x: 48, y: 26, width: 104, height: 44, rx: 20 }, screenClip)
  const screen = el('g', { 'clip-path': 'url(#m-screen-clip)' }, gHead)
  el('rect', { x: 48, y: 26, width: 104, height: 44, rx: 20, fill: 'url(#m-screen)' }, screen)
  el('rect', { x: 58, y: 18, width: 22, height: 70, rx: 10, fill: '#ffffff', opacity: 0.07, transform: 'rotate(18 69 53)' }, screen)

  // 眼睛（普通态：发光椭圆；done 态：弯月弧线）
  const eyesNormal = el('g', {}, gHead)
  const eyeL = el('ellipse', { cx: 76, cy: 48, rx: 12, ry: 15, fill: '#3ae0e6', filter: 'url(#m-glow)' }, eyesNormal)
  const eyeR = el('ellipse', { cx: 124, cy: 48, rx: 12, ry: 15, fill: '#3ae0e6', filter: 'url(#m-glow)' }, eyesNormal)
  const eyesHappy = el('g', { opacity: 0 }, gHead)
  el('path', { d: 'M63,52 Q76,36 89,52', stroke: '#3ae0e6', 'stroke-width': 5.5, fill: 'none', 'stroke-linecap': 'round', filter: 'url(#m-glow)' }, eyesHappy)
  el('path', { d: 'M111,52 Q124,36 137,52', stroke: '#3ae0e6', 'stroke-width': 5.5, fill: 'none', 'stroke-linecap': 'round', filter: 'url(#m-glow)' }, eyesHappy)

  // 脖圈
  el('rect', { x: 64, y: 82, width: 72, height: 11, rx: 5.5, fill: 'url(#m-orange)' }, gBob)

  // 躯干 + 腹板描线
  el('rect', { x: 48, y: 90, width: 104, height: 72, rx: 34, fill: 'url(#m-body)', stroke: '#cfd8e1', 'stroke-width': 1 }, gBob)
  el('path', { d: 'M78,104 L122,104 L116,136 L84,136 Z', fill: 'none', stroke: '#e8842c', 'stroke-width': 2.2, opacity: 0.85 }, gBob)
  el('circle', { cx: 128, cy: 112, r: 3, fill: '#c2cad2' }, gBob)

  // 键盘（busy 态淡入）
  const keyboard = el('g', { opacity: 0 }, gBob)
  el('rect', { x: 58, y: 134, width: 84, height: 9, rx: 4.5, fill: '#35e0e6', opacity: 0.55, filter: 'url(#m-glow)' }, keyboard)
  el('rect', { x: 64, y: 145, width: 72, height: 5, rx: 2.5, fill: '#35e0e6', opacity: 0.28 }, keyboard)

  // 手臂（肩部枢轴旋转）
  const makeArm = (px: number, py: number): SVGGElement => {
    const g = el('g', { transform: `translate(${px} ${py})` }, gBob)
    el('rect', { x: -9, y: -2, width: 18, height: 32, rx: 9, fill: 'url(#m-body)', stroke: '#cfd8e1', 'stroke-width': 1 }, g)
    el('circle', { cx: 0, cy: 36, r: 8, fill: '#f4f7fa', stroke: '#c9d2da', 'stroke-width': 1.5 }, g)
    return g
  }
  const armL = makeArm(52, 102)
  const armR = makeArm(148, 102)

  // 脚
  for (const x of [66, 108]) {
    el('rect', { x, y: 158, width: 26, height: 15, rx: 7.5, fill: 'url(#m-orange)' }, gBob)
    el('rect', { x: x + 5, y: 164, width: 15, height: 7, rx: 3.5, fill: '#ffffff', opacity: 0.9 }, gBob)
  }

  // done 星星
  const sparkle = (cx: number, cy: number, ph: number): SVGGElement => {
    const g = el('g', { transform: `translate(${cx} ${cy})`, opacity: 0 }, svg)
    el('path', { d: 'M0,-7 L2,-2 L7,0 L2,2 L0,7 L-2,2 L-7,0 L-2,-2 Z', fill: '#bfe9ec' }, g)
    g.dataset.cx = String(cx)
    g.dataset.cy = String(cy)
    g.dataset.ph = String(ph)
    return g
  }
  const sparkles = [sparkle(46, 24, 0), sparkle(156, 20, 2.1), sparkle(172, 62, 4.2)]

  // error 告警牌
  const badge = el('g', { opacity: 0 }, svg)
  el('path', { d: 'M168,14 L182,40 L154,40 Z', fill: '#ff5a3c', stroke: '#ffffff', 'stroke-width': 2, 'stroke-linejoin': 'round' }, badge)
  el('rect', { x: 166.6, y: 22, width: 2.8, height: 9, rx: 1.4, fill: '#ffffff' }, badge)
  el('circle', { cx: 168, cy: 35.5, r: 1.7, fill: '#ffffff' }, badge)

  // ---- 动画循环 ----
  let state: MascotState = 'idle'
  let raf = 0
  const t0 = performance.now() / 1000 + Math.random() * 3.4 // 每实例眨眼错相
  let kbOpacity = 0

  function tick(nowMs: number): void {
    raf = requestAnimationFrame(tick)
    if (document.hidden) return
    const t = nowMs / 1000 - t0

    // 身体起伏与抖动
    let bob = Math.sin(t * 2.2) * 2.4
    let tilt = Math.sin(t * 0.9) * 1.6
    let shakeX = 0
    if (state === 'busy') bob = Math.sin(t * 4.6) * 1.8
    if (state === 'error') {
      shakeX = Math.sin(t * 30) * 1.6 * (0.55 + 0.45 * Math.sin(t * 1.3))
    }
    gBob.setAttribute('transform', `translate(${shakeX} ${bob}) rotate(${tilt} 100 110)`)
    shadow.setAttribute('rx', String(44 - bob * 1.4))
    shadow.setAttribute('opacity', String(0.2 - bob * 0.02))

    // 头部微动
    const headTilt = state === 'busy' ? 3 : Math.sin(t * 1.1) * 2.2
    gHead.setAttribute('transform', `rotate(${headTilt} 100 80)`)

    // 眨眼（周期 3.4s，闭 0.18s）
    const p = t % 3.4
    const k = p > 3.22 ? Math.sin(((p - 3.22) / 0.18) * Math.PI) : 0
    const sy = 1 - 0.92 * k
    for (const [eye, cx] of [[eyeL, 76], [eyeR, 124]] as const) {
      eye.setAttribute('transform', `translate(${cx} 48) scale(1 ${sy}) translate(${-cx} -48)`)
      eye.setAttribute('ry', String(state === 'busy' ? 12.5 : 15))
      eye.setAttribute('fill', state === 'error' ? '#ff6a3d' : '#3ae0e6')
    }
    eyesNormal.setAttribute('opacity', state === 'done' ? '0' : '1')
    eyesHappy.setAttribute('opacity', state === 'done' ? '1' : '0')

    // 天线灯
    ball.setAttribute('r', String(4.6 + Math.sin(t * (state === 'done' ? 9 : 3)) * 0.9))
    if (state === 'error') {
      ball.setAttribute('fill', '#ff4d3a')
      ball.setAttribute('opacity', String(0.45 + 0.55 * Math.abs(Math.sin(t * 9))))
    } else {
      ball.setAttribute('fill', '#f6a12d')
      ball.removeAttribute('opacity')
    }

    // 手臂
    let armLdeg: number, armRdeg: number
    if (state === 'busy') {
      armLdeg = -17 - Math.sin(t * 9) * 7
      armRdeg = 17 + Math.sin(t * 9 + Math.PI) * 7
    } else if (state === 'done') {
      armLdeg = 5 + Math.sin(t * 1.6) * 2
      armRdeg = -150 + Math.sin(t * 7) * 20
    } else if (state === 'error') {
      armLdeg = -9 + Math.sin(t * 24) * 2
      armRdeg = 9 - Math.sin(t * 24) * 2
    } else {
      armLdeg = 4 + Math.sin(t * 1.6) * 2.5
      armRdeg = -4 - Math.sin(t * 1.6 + 0.5) * 2.5
    }
    armL.setAttribute('transform', `translate(52 102) rotate(${armLdeg})`)
    armR.setAttribute('transform', `translate(148 102) rotate(${armRdeg})`)

    // 键盘淡入淡出
    const kbTarget = state === 'busy' ? 1 : 0
    kbOpacity += (kbTarget - kbOpacity) * 0.12
    keyboard.setAttribute('opacity', kbOpacity.toFixed(3))

    // 星星
    for (const g of sparkles) {
      if (state === 'done') {
        const ph = Number(g.dataset.ph)
        const cx = Number(g.dataset.cx)
        const cy = Number(g.dataset.cy)
        const v = 0.35 + 0.55 * Math.max(0, Math.sin(t * 3.6 + ph))
        const s = 0.75 + 0.3 * Math.sin(t * 3.6 + ph)
        g.setAttribute('opacity', v.toFixed(2))
        g.setAttribute('transform', `translate(${cx} ${cy}) scale(${s.toFixed(3)})`)
      } else {
        g.setAttribute('opacity', '0')
      }
    }

    // 告警牌
    badge.setAttribute('opacity', state === 'error' ? String(0.5 + 0.5 * Math.abs(Math.sin(t * 6))) : '0')
  }
  raf = requestAnimationFrame(tick)

  return {
    svg,
    setState(s: MascotState): void {
      state = s
    },
    destroy(): void {
      cancelAnimationFrame(raf)
      svg.remove()
    },
  }
}
