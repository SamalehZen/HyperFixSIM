/**
 * Store en mémoire pour les streams de chat nao.
 * Le POST /api/mothership/chat appelle nao, stocke les événements AI SDK UI,
 * le GET /api/mothership/chat/stream les lit et les convertit en Mothership.
 */
interface StreamEntry {
  chatId: string
  status: 'pending' | 'streaming' | 'done'
  events: ChunkEntry[]
  model: string
  createdAt: number
}

interface ChunkEntry {
  type: string
  data: string
}

const streams = new Map<string, StreamEntry>()

const TTL_MS = 5 * 60 * 1000

export function createStream(streamId: string, chatId: string, model: string): void {
  streams.set(streamId, { chatId, status: 'pending', events: [], model, createdAt: Date.now() })
}

export function getStream(streamId: string): StreamEntry | undefined {
  return streams.get(streamId)
}

export function appendEvent(streamId: string, chunk: ChunkEntry): void {
  const entry = streams.get(streamId)
  if (entry) {
    entry.events.push(chunk)
    entry.status = 'streaming'
  }
}

export function setStreamDone(streamId: string): void {
  const entry = streams.get(streamId)
  if (entry) entry.status = 'done'
}

/** Nettoie les streams expirés (plus de 5 minutes) */
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of streams) {
    if (now - entry.createdAt > TTL_MS) {
      streams.delete(key)
    }
  }
}, 60_000)
