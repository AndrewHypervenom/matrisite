import { useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'

const STATUS_LABEL: Record<string, string> = {
  idle: 'En cola',
  indexing: 'Indexando…',
  ready: 'Actualizado',
  error: 'Error',
}
const STATUS_COLOR: Record<string, string> = {
  idle: 'bg-white/10 text-white/60',
  indexing: 'bg-amber-500/20 text-amber-300',
  ready: 'bg-emerald-500/20 text-emerald-300',
  error: 'bg-red-500/20 text-red-300',
}

export function RepoBar({
  repos,
  activeId,
  onSelect,
}: {
  repos: Doc<'repos'>[] | undefined
  activeId: Id<'repos'> | null
  onSelect: (id: Id<'repos'>) => void
}) {
  const addRepo = useMutation(api.repos.addRepo)
  const reindex = useMutation(api.repos.reindexRepo)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)

  const active = repos?.find((r) => r._id === activeId) ?? null

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const parsed = parseRepo(input.trim())
    if (!parsed) {
      setError('Formato: owner/repo o URL de GitHub')
      return
    }
    const id = await addRepo(parsed)
    setInput('')
    onSelect(id)
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/10 bg-white/5 p-2">
      {repos && repos.length > 0 && (
        <select
          value={activeId ?? ''}
          onChange={(e) => onSelect(e.target.value as Id<'repos'>)}
          className="rounded-lg bg-white/10 px-2 py-1.5 text-sm outline-none"
        >
          {repos.map((r) => (
            <option key={r._id} value={r._id} className="bg-neutral-900">
              {r.owner}/{r.name}
            </option>
          ))}
        </select>
      )}

      {active && (
        <>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              STATUS_COLOR[active.status] ?? STATUS_COLOR.idle
            }`}
          >
            {STATUS_LABEL[active.status] ?? active.status}
            {active.status === 'indexing' && active.filesTotal
              ? ` · ${active.filesProcessed ?? 0}/${active.filesTotal} archivos`
              : ''}
            {active.status === 'ready' && active.fileCount
              ? ` · ${active.fileCount} archivos`
              : ''}
          </span>
          <button
            onClick={() => reindex({ repoId: active._id })}
            className="rounded-lg px-2 py-1 text-xs text-white/60 hover:bg-white/10"
            title="Re-indexar"
          >
            ↻ Re-indexar
          </button>
        </>
      )}

      <form
        onSubmit={onAdd}
        className="flex flex-1 items-center gap-1 min-w-[12rem]"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="owner/repo o URL de GitHub"
          className="min-w-0 flex-1 rounded-lg bg-white/10 px-3 py-1.5 text-sm outline-none placeholder:text-white/30"
        />
        <button className="shrink-0 rounded-lg bg-brand px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          Añadir
        </button>
      </form>
      {error && <p className="w-full text-xs text-red-300">{error}</p>}
      {active?.status === 'error' && active.lastError && (
        <p className="w-full text-xs text-red-300">⚠ {active.lastError}</p>
      )}
    </div>
  )
}

function parseRepo(text: string): { owner: string; name: string } | null {
  const clean = text
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/\/$/, '')
  const parts = clean.split('/')
  if (parts.length < 2 || !parts[0] || !parts[1]) return null
  return { owner: parts[0], name: parts[1] }
}
