type Citation = {
  path: string
  startLine?: number
  endLine?: number
  url: string
  score?: number
}

export function Citations({ citations }: { citations: Citation[] }) {
  if (!citations || citations.length === 0) return null
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {citations.map((c, i) => (
        <a
          key={`${c.path}-${c.startLine}-${i}`}
          href={c.url}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70 hover:border-brand hover:text-white"
          title={c.url}
        >
          <span className="font-mono">{fileName(c.path)}</span>
          {c.startLine ? (
            <span className="text-white/40 group-hover:text-brand">
              :{c.startLine}
              {c.endLine && c.endLine !== c.startLine ? `-${c.endLine}` : ''}
            </span>
          ) : null}
        </a>
      ))}
    </div>
  )
}

function fileName(path: string): string {
  const parts = path.split('/')
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path
}
