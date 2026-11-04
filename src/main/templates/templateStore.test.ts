import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildTasksFromTemplate,
  extractVariables,
  getTemplate,
  initTemplatesRoot,
  listTemplates,
  missingVariables,
  removeTemplate,
  renderTemplate,
  saveTemplate
} from './templateStore'
import type { TemplateRecord } from '../../shared/types'

let tmp: string | null = null

function useTmpRoot(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tpl-'))
  initTemplatesRoot(tmp)
  return tmp
}

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

describe('变量提取与渲染', () => {
  it('提取 {{变量}}：去重、保序、容忍空白', () => {
    expect(extractVariables('写一篇关于 {{topic}} 的文章，风格 {{style}}，主题 {{ topic }}')).toEqual([
      'topic',
      'style'
    ])
    expect(extractVariables('{{a}} 和 {{a}}')).toEqual(['a'])
    expect(extractVariables('没有变量')).toEqual([])
    expect(extractVariables('{{}} 和 {{  }} 非法占位')).toEqual([])
    expect(extractVariables('{{a b}} 带空格不算')).toEqual([])
  })

  it('渲染：全部出现处替换，未知变量原样保留', () => {
    const out = renderTemplate('{{greet}}，请总结 {{topic}}；再见 {{greet}}', {
      greet: '你好',
      topic: 'AI'
    })
    expect(out).toBe('你好，请总结 AI；再见 你好')
    expect(renderTemplate('缺 {{x}}', {})).toBe('缺 {{x}}')
  })

  it('missingVariables：空值与纯空白都算缺', () => {
    expect(missingVariables('{{a}} {{b}}', { a: 'x', b: '' })).toEqual(['b'])
    expect(missingVariables('{{a}} {{b}}', { a: 'x', b: '  ' })).toEqual(['b'])
    expect(missingVariables('{{a}}', { a: 'x' })).toEqual([])
  })
})

describe('模板 CRUD（落盘）', () => {
  it('新建 → 列表 → 读取 → 更新（保留 createdAt）→ 删除', () => {
    useTmpRoot()
    const t1 = saveTemplate({ name: '周报', prompt: '汇总 {{week}} 的进展', tier: 'haiku' })
    const t2 = saveTemplate({ name: '翻译', prompt: '把 {{text}} 译成英文' })
    expect(t1.id).toMatch(/^[0-9a-f]{20}$/)
    expect(t1.tier).toBe('haiku')
    expect(listTemplates().map((t) => t.name)).toEqual(['翻译', '周报']) // updatedAt 倒序

    const got = getTemplate(t1.id)
    expect(got?.prompt).toBe('汇总 {{week}} 的进展')

    const updated = saveTemplate({ id: t1.id, name: '周报V2', prompt: '汇总 {{week}} 的进展与风险' })
    expect(updated.id).toBe(t1.id)
    expect(updated.createdAt).toBe(t1.createdAt)
    expect(updated.updatedAt).toBeGreaterThanOrEqual(t1.updatedAt)
    expect(getTemplate(t1.id)?.name).toBe('周报V2')

    expect(removeTemplate(t2.id)).toBe(true)
    expect(getTemplate(t2.id)).toBeNull()
    expect(listTemplates()).toHaveLength(1)
  })

  it('名字为空回退未命名模板；缺省档位 sonnet', () => {
    useTmpRoot()
    const t = saveTemplate({ name: '  ', prompt: 'x' })
    expect(t.name).toBe('未命名模板')
    expect(t.tier).toBe('sonnet')
    expect(t.maxRetries).toBe(1)
  })
})

describe('buildTasksFromTemplate：模板 × 变量组 → 任务', () => {
  const tpl: TemplateRecord = {
    id: 't1',
    name: '周报',
    description: '',
    prompt: '汇总 {{week}} 的进展',
    tier: 'sonnet',
    maxTokens: 2048,
    maxRetries: 2,
    createdAt: 0,
    updatedAt: 0
  }

  it('单组变量 → 一条任务，标题无后缀', () => {
    const tasks = buildTasksFromTemplate(tpl, [{ week: 'W42' }])
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toBe('周报')
    expect(tasks[0].prompt).toBe('汇总 W42 的进展')
    expect(tasks[0].tier).toBe('sonnet')
    expect(tasks[0].maxTokens).toBe(2048)
    expect(tasks[0].maxRetries).toBe(2)
    expect(tasks[0].status).toBe('queued')
  })

  it('多组变量 → 多条任务，标题带 i/N 后缀', () => {
    const tasks = buildTasksFromTemplate(tpl, [{ week: 'W42' }, { week: 'W43' }])
    expect(tasks.map((t) => t.title)).toEqual(['周报 · 1/2', '周报 · 2/2'])
    expect(tasks.map((t) => t.prompt)).toEqual(['汇总 W42 的进展', '汇总 W43 的进展'])
  })

  it('多变量逐行驱动：行数取最大值，单值变量复用', () => {
    const multi: TemplateRecord = { ...tpl, prompt: '{{a}}-{{b}}' }
    const tasks = buildTasksFromTemplate(multi, [
      { a: '1', b: 'x' },
      { a: '2', b: 'x' },
      { a: '3', b: 'x' }
    ])
    expect(tasks.map((t) => t.prompt)).toEqual(['1-x', '2-x', '3-x'])
  })

  it('空变量组 → 空任务列表', () => {
    expect(buildTasksFromTemplate(tpl, [])).toEqual([])
  })
})
