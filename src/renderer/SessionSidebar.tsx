import { useState } from 'react'
import type { SessionMeta, SessionProject } from '../shared/preload-api'

interface Props {
  sessions: SessionMeta[]
  projects: SessionProject[]
  activeSessionId: string | null
  activeProjectId: string | null
  timeAgo: (ts: number) => string
  onOpenSession: (id: string) => void
  onNewInProject: (projectId: string | null) => void
  /** 任何数据变更后由父层重新拉取 sessions/projects */
  onChanged: () => void
}

/** 单条会话行（含悬停操作菜单：移到项目 / 归档 / 删除） */
function SessionRow(props: {
  s: SessionMeta
  projects: SessionProject[]
  active: boolean
  timeAgo: (ts: number) => string
  onOpen: () => void
  onChanged: () => void
}): React.JSX.Element {
  const { s, projects, active, timeAgo, onOpen, onChanged } = props
  const [menu, setMenu] = useState(false)

  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    await fn()
    setMenu(false)
    onChanged()
  }

  return (
    <div className={`group rounded ${active ? 'bg-[#1a2730]' : 'hover:bg-[#151b21]'}`}>
      <div className="flex items-start gap-1 px-2 py-1.5 cursor-pointer" onClick={onOpen}>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-[#cdd8e0] truncate">
            {s.archived && <span className="text-[10px] text-[#6d8294] mr-1">[归档]</span>}
            {s.title}
          </div>
          <div className="text-[10px] text-[#5f7382] truncate">
            {timeAgo(s.updatedAt)} · {s.messageCount} 条
          </div>
        </div>
        <button
          className="opacity-0 group-hover:opacity-100 text-[#6d8294] hover:text-[#9fb3bf] text-xs px-1"
          title="更多操作"
          onClick={(e) => {
            e.stopPropagation()
            setMenu((v) => !v)
          }}
        >
          ⋯
        </button>
      </div>

      {menu && (
        <div className="mx-2 mb-1.5 rounded bg-[#0f151a] border border-[#232c35] p-1.5 space-y-1">
          <select
            className="w-full bg-[#151b21] border border-[#232c35] rounded px-1.5 py-1 text-[11px] text-[#cdd8e0]"
            value={s.projectId ?? ''}
            onChange={(e) => void act(() => window.workbench.setSessionProject(s.id, e.target.value || null))}
            onClick={(e) => e.stopPropagation()}
          >
            <option value="">未分组</option>
            {projects
              .filter((p) => !p.archived)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
          <div className="flex gap-1">
            <button
              className="flex-1 text-[11px] px-1.5 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
              onClick={(e) => {
                e.stopPropagation()
                void act(() => window.workbench.archiveSession(s.id, !s.archived))
              }}
            >
              {s.archived ? '取消归档' : '归档'}
            </button>
            <button
              className="flex-1 text-[11px] px-1.5 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] hover:text-[#e07a7a]"
              onClick={(e) => {
                e.stopPropagation()
                if (!confirm(`删除会话「${s.title}」？此操作不可撤销。`)) return
                void act(() => window.workbench.removeSession(s.id))
              }}
            >
              删除
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** 会话列表：按项目分组 + 已归档折叠区（对齐 Claude Desktop） */
export default function SessionSidebar(props: Props): React.JSX.Element {
  const { sessions, projects, activeSessionId, activeProjectId, timeAgo, onOpenSession, onNewInProject, onChanged } =
    props
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  /** 新建项目的内联输入（Electron 不支持 window.prompt，必须用内联表单） */
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  /** 项目操作面板：哪个项目展开了菜单 / 正在重命名 */
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const live = sessions.filter((s) => !s.archived)
  const archivedSessions = sessions.filter((s) => s.archived)
  const byProject = (pid: string): SessionMeta[] => live.filter((s) => s.projectId === pid)
  const ungrouped = live.filter((s) => !s.projectId || !projects.some((p) => p.id === s.projectId && !p.archived))
  const activeProjects = projects.filter((p) => !p.archived)
  const archivedProjects = projects.filter((p) => p.archived)

  const submitNewProject = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    await window.workbench.saveProject({ name })
    setNewName('')
    setCreating(false)
    onChanged()
  }

  const submitRename = async (p: SessionProject): Promise<void> => {
    const name = renameValue.trim()
    if (name && name !== p.name) {
      await window.workbench.saveProject({ id: p.id, name, description: p.description })
      onChanged()
    }
    setRenamingId(null)
    setMenuFor(null)
  }

  return (
    <div className="flex-1 overflow-y-auto px-2 space-y-1">
      <div className="px-2 pt-3 pb-1 flex items-center gap-1">
        <span className="text-[11px] tracking-wider text-[#6d8294] uppercase">项目</span>
        <button
          className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
          onClick={() => {
            setCreating((v) => !v)
            setNewName('')
          }}
        >
          + 新建
        </button>
      </div>

      {creating && (
        <div className="flex items-center gap-1 px-2 pb-1">
          <input
            autoFocus
            className="flex-1 min-w-0 bg-[#12181e] border border-[#2f6f7a] rounded px-1.5 py-1 text-[11px] text-[#e8eef4] focus:outline-none"
            placeholder="项目名，如：短剧项目"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNewProject()
              if (e.key === 'Escape') setCreating(false)
            }}
          />
          <button
            className="text-[10px] px-1.5 py-1 rounded bg-[#1e93a3] text-[#06282c]"
            onClick={() => void submitNewProject()}
          >
            确定
          </button>
        </div>
      )}

      {/* 未分组会话 */}
      {ungrouped.length > 0 && (
        <div>
          <div className="px-2 py-0.5 text-[10px] text-[#5f7382]">未分组</div>
          {ungrouped.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              projects={projects}
              active={s.id === activeSessionId}
              timeAgo={timeAgo}
              onOpen={() => onOpenSession(s.id)}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {/* 各项目 */}
      {activeProjects.map((p) => {
        const items = byProject(p.id)
        const open = !collapsed[p.id]
        return (
          <div key={p.id}>
            <div className="group flex items-center gap-1 px-2 py-0.5">
              <button
                className="text-[10px] text-[#6d8294] w-3 shrink-0"
                onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}
              >
                {open ? '▾' : '▸'}
              </button>
              <span
                className={`text-[11px] truncate ${
                  activeProjectId === p.id ? 'text-[#53d3e0]' : 'text-[#8b9aa7]'
                }`}
                title={p.description || p.name}
              >
                {p.name}
              </span>
              <span className="text-[10px] text-[#5f7382]">{items.length}</span>
              <button
                className="opacity-0 group-hover:opacity-100 text-[#6d8294] hover:text-[#9fb3bf] text-[10px] px-1"
                title="在该项目下新建会话"
                onClick={() => onNewInProject(p.id)}
              >
                +
              </button>
              <button
                className="opacity-0 group-hover:opacity-100 text-[#6d8294] hover:text-[#9fb3bf] text-[10px] px-1"
                title="重命名 / 归档 / 删除项目"
                onClick={() => setMenuFor((v) => (v === p.id ? null : p.id))}
              >
                ⋯
              </button>
            </div>
            {menuFor === p.id && (
              <div className="mx-2 mb-1 rounded bg-[#0f151a] border border-[#232c35] p-1.5 space-y-1">
                {renamingId === p.id ? (
                  <div className="flex gap-1">
                    <input
                      autoFocus
                      className="flex-1 min-w-0 bg-[#12181e] border border-[#2f6f7a] rounded px-1.5 py-1 text-[11px] text-[#e8eef4] focus:outline-none"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename(p)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                    />
                    <button
                      className="text-[10px] px-1.5 py-1 rounded bg-[#1e93a3] text-[#06282c]"
                      onClick={() => void submitRename(p)}
                    >
                      确定
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      className="w-full text-left text-[11px] px-1.5 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                      onClick={() => {
                        setRenamingId(p.id)
                        setRenameValue(p.name)
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="w-full text-left text-[11px] px-1.5 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf]"
                      onClick={() =>
                        void window.workbench.archiveProject(p.id, true).then(() => {
                          setMenuFor(null)
                          onChanged()
                        })
                      }
                    >
                      归档项目
                    </button>
                    <button
                      className="w-full text-left text-[11px] px-1.5 py-1 rounded bg-[#1a2129] hover:bg-[#24303b] text-[#9fb3bf] hover:text-[#e07a7a]"
                      onClick={() => {
                        if (!confirm(`删除项目「${p.name}」？其下会话会退回未分组，不会被删除。`)) return
                        void window.workbench.removeProject(p.id).then(() => {
                          setMenuFor(null)
                          onChanged()
                        })
                      }}
                    >
                      删除项目
                    </button>
                  </>
                )}
              </div>
            )}
            {open &&
              (items.length === 0 ? (
                <div className="px-7 py-0.5 text-[10px] text-[#4a5763]">空项目，点 + 开始</div>
              ) : (
                items.map((s) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    projects={projects}
                    active={s.id === activeSessionId}
                    timeAgo={timeAgo}
                    onOpen={() => onOpenSession(s.id)}
                    onChanged={onChanged}
                  />
                ))
              ))}
          </div>
        )
      })}

      {/* 已归档（会话 + 项目） */}
      {(archivedSessions.length > 0 || archivedProjects.length > 0) && (
        <div className="pt-1">
          <button
            className="w-full text-left px-2 py-1 text-[10px] text-[#6d8294] hover:text-[#9fb3bf]"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? '▾' : '▸'} 已归档（{archivedSessions.length + archivedProjects.length}）
          </button>
          {showArchived && (
            <>
              {archivedProjects.map((p) => (
                <div key={p.id} className="flex items-center gap-1 px-2 py-0.5">
                  <span className="text-[11px] text-[#5f7382] truncate">项目：{p.name}</span>
                  <button
                    className="ml-auto text-[10px] px-1 text-[#6d8294] hover:text-[#9fb3bf]"
                    onClick={() =>
                      void window.workbench.archiveProject(p.id, false).then(() => onChanged())
                    }
                  >
                    取消归档
                  </button>
                </div>
              ))}
              {archivedSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  projects={projects}
                  active={s.id === activeSessionId}
                  timeAgo={timeAgo}
                  onOpen={() => onOpenSession(s.id)}
                  onChanged={onChanged}
                />
              ))}
            </>
          )}
        </div>
      )}

      {sessions.length === 0 && (
        <div className="px-2 py-3 text-xs text-[#5a6a76]">暂无历史，发送第一条消息后自动保存</div>
      )}
    </div>
  )
}
