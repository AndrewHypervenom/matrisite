import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from 'convex/react'
import ReactMarkdown from 'react-markdown'
import { api } from '../../convex/_generated/api'
import type { Doc, Id } from '../../convex/_generated/dataModel'
import { Citations } from './CitationCard'

type Mode = 'ask' | 'plan'

export function ChatPanel({ repo }: { repo: Doc<'repos'> }) {
  const [mode, setMode] = useState<Mode>('ask')
  const [conversationId, setConversationId] = useState<Id<'conversations'> | null>(
    null,
  )
  const [text, setText] = useState('')
  const sendMessage = useMutation(api.chat.sendMessage)

  const messages = useQuery(
    api.chat.listMessages,
    conversationId ? { conversationId } : 'skip',
  )

  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const notReady = repo.status !== 'ready'

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const q = text.trim()
    if (!q) return
    setText('')
    const res = await sendMessage({
      repoId: repo._id,
      conversationId: conversationId ?? undefined,
      mode,
      text: q,
    })
    setConversationId(res.conversationId)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col py-3">
      <div className="mb-2 flex items-center gap-2">
        <ModeToggle mode={mode} setMode={setMode} />
        <button
          onClick={() => setConversationId(null)}
          className="ml-auto rounded-lg px-2 py-1 text-xs text-white/50 hover:bg-white/10"
        >
          + Nueva conversación
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-white/10 bg-white/[0.03] p-4">
        {!messages || messages.length === 0 ? (
          <EmptyState mode={mode} slug={`${repo.owner}/${repo.name}`} />
        ) : (
          messages.map((m) => <MessageBubble key={m._id} message={m} />)
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={onSubmit} className="mt-3 flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={notReady}
          placeholder={
            notReady
              ? 'Esperando a que termine la indexación…'
              : mode === 'ask'
                ? 'Pregunta cómo funciona algo del código…'
                : 'Describe el cambio que quieres hacer…'
          }
          className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:border-brand disabled:opacity-50"
        />
        <button
          disabled={notReady}
          className="rounded-xl bg-brand px-5 py-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
        >
          Enviar
        </button>
      </form>
    </div>
  )
}

function ModeToggle({
  mode,
  setMode,
}: {
  mode: Mode
  setMode: (m: Mode) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-0.5 text-sm">
      {(['ask', 'plan'] as Mode[]).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          className={`rounded-md px-3 py-1.5 transition ${
            mode === m ? 'bg-brand text-white' : 'text-white/60 hover:text-white'
          }`}
        >
          {m === 'ask' ? 'Preguntar' : 'Planificar cambio'}
        </button>
      ))}
    </div>
  )
}

function MessageBubble({ message }: { message: Doc<'messages'> }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-brand text-white'
            : 'border border-white/10 bg-white/5 text-white/90'
        }`}
      >
        {message.status === 'pending' ? (
          <Thinking />
        ) : isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="md">
            <ReactMarkdown>{message.content}</ReactMarkdown>
            {message.citations && <Citations citations={message.citations} />}
          </div>
        )}
      </div>
    </div>
  )
}

function Thinking() {
  return (
    <div className="flex items-center gap-1 py-1 text-white/50">
      <span className="h-2 w-2 animate-bounce rounded-full bg-white/50 [animation-delay:-0.3s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-white/50 [animation-delay:-0.15s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-white/50" />
    </div>
  )
}

function EmptyState({ mode, slug }: { mode: Mode; slug: string }) {
  const examples =
    mode === 'ask'
      ? [
          '¿Cómo fluye una request desde el endpoint hasta la base de datos?',
          '¿Dónde se configura la autenticación?',
          '¿Qué hace este proyecto y cómo arranco en local?',
        ]
      : [
          'Quiero añadir un campo "phone" al perfil de usuario.',
          'Agregar un endpoint para exportar datos a CSV.',
          'Cambiar el proveedor de emails.',
        ]
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-white/50">
      <p className="text-sm">
        {mode === 'ask'
          ? `Pregunta lo que sea sobre ${slug}.`
          : `Describe un cambio y te digo qué archivos tocar y por qué.`}
      </p>
      <ul className="space-y-1 text-xs text-white/40">
        {examples.map((ex) => (
          <li key={ex}>“{ex}”</li>
        ))}
      </ul>
    </div>
  )
}
