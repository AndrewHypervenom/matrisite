import { useState } from 'react'
import { useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import type { Id } from '../convex/_generated/dataModel'
import { RepoBar } from './components/RepoBar'
import { ChatPanel } from './components/ChatPanel'

export default function App() {
  const repos = useQuery(api.repos.listRepos)
  const [selected, setSelected] = useState<Id<'repos'> | null>(null)

  const activeRepo =
    repos?.find((r) => r._id === selected) ?? repos?.[0] ?? null

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col px-4">
      <header className="flex items-center gap-3 py-5">
        <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-lg font-bold text-white">
          M
        </div>
        <div>
          <h1 className="text-lg font-semibold leading-tight">Matrisite</h1>
          <p className="text-xs text-white/50">
            Documentación viva: pregunta cómo funciona tu código
          </p>
        </div>
      </header>

      <RepoBar
        repos={repos}
        activeId={activeRepo?._id ?? null}
        onSelect={setSelected}
      />

      {activeRepo ? (
        <ChatPanel key={activeRepo._id} repo={activeRepo} />
      ) : (
        <div className="flex flex-1 items-center justify-center text-center text-white/50">
          {repos === undefined
            ? 'Cargando…'
            : 'Conecta un repositorio público de GitHub para empezar.'}
        </div>
      )}
    </div>
  )
}
