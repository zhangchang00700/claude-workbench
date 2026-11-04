/**
 * 取主进程 API 的统一入口。
 *
 * 顺序：
 *   ① UI 自检桩 __wbStub —— 由 scripts/ui-*-check.mjs 经 CDP 注入，生产环境恒为 undefined
 *   ② window.workbench 真实桥接
 *
 * 契约尚未落到 preload 时返回 undefined，调用方按「通道缺失」降级显示，
 * 不抛错、不白屏——这样渲染层可以先于主进程交付。
 */
export function pick(key: string): unknown {
  const stub = (window as unknown as { __wbStub?: Record<string, unknown> }).__wbStub
  const fromStub = stub?.[key]
  if (fromStub) return fromStub
  try {
    return (window.workbench as unknown as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}
