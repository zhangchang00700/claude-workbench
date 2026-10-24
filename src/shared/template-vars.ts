/**
 * 模板变量纯函数（M3）。渲染层与主进程共用，无 IO 依赖。
 * 主进程 templateStore 与本文件保持单一真源：改占位符规则只改这里。
 */

/** {{变量名}} 占位符。变量名不允许含空格与花括号 */
const VAR_PATTERN = /\{\{\s*([^{}\s]+)\s*\}\}/g

/** 提取模板中的变量名（去重、保序） */
export function extractVariables(prompt: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of (prompt ?? '').matchAll(VAR_PATTERN)) {
    const name = m[1]
    if (!seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

/**
 * 渲染模板：已知变量替换（全部出现处），未知变量原样保留——
 * 预览时用户能直接看到还有哪些 {{}} 没填，不会静默产出半成品。
 */
export function renderTemplate(prompt: string, vars: Record<string, string>): string {
  return (prompt ?? '').replace(VAR_PATTERN, (whole, name: string) => {
    const v = vars[name]
    return v === undefined ? whole : v
  })
}

/** 渲染后仍残缺的变量名（入队前校验用：空值与纯空白都算缺） */
export function missingVariables(prompt: string, vars: Record<string, string>): string[] {
  return extractVariables(prompt).filter((name) => {
    const v = vars[name]
    return v === undefined || v.trim() === ''
  })
}

/**
 * 把每个变量的多行文本组合成「一行一任务」的变量组。
 * 行数取所有变量中非空行数的最大值；只有一个取值的变量对所有行复用。
 * 全部为空时返回一行空值（由调用方的缺失校验拦截）。
 */
export function buildVarRows(
  vars: string[],
  values: Record<string, string>
): Record<string, string>[] {
  const linesOf = (name: string): string[] =>
    (values[name] ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
  const rowCount = Math.max(1, ...vars.map((v) => linesOf(v).length))
  const rows: Record<string, string>[] = []
  for (let i = 0; i < rowCount; i++) {
    const row: Record<string, string> = {}
    for (const v of vars) {
      const lines = linesOf(v)
      row[v] = lines[i] ?? lines[0] ?? ''
    }
    rows.push(row)
  }
  return rows
}
