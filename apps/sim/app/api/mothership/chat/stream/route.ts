import type { NextRequest } from 'next/server'
import { mothershipChatStreamQuerySchema } from '@/lib/api/contracts/mothership-chats'
import { validationErrorResponse } from '@/lib/api/server'
import { getStream } from '@/lib/nao-stream/store'

export const maxDuration = 3600

const encoder = new TextEncoder()

/**
 * GET /api/mothership/chat/stream
 *
 * Replay des événements d'un stream nao déjà démarré (resume après reconnect).
 * Les événements sont lus depuis le store en mémoire (rempli par le POST).
 */
export function GET(request: NextRequest) {
  const validation = mothershipChatStreamQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries())
  )
  if (!validation.success) return validationErrorResponse(validation.error)

  const streamId = (request.nextUrl.searchParams.get('streamId') as string) || ''
  const after = (request.nextUrl.searchParams.get('after') as string) || '0'

  const entry = getStream(streamId)
  if (!entry) {
    // Stream inconnu (expiré ou jamais créé) — stream vide terminal
    return new Response(encoder.encode(''), {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  const afterCursor = Number.parseInt(after, 10) || 0
  const events = entry.events
    .map((e) => JSON.parse(e.data))
    .filter((env) => Number.parseInt(String(env.seq), 10) > afterCursor)

  // Si tous les événements ont déjà été livrés et que le stream est fini,
  // on renvoie juste un complete terminal pour terminer proprement
  if (events.length === 0) {
    if (entry.status === 'done') {
      const done = buildCompleteEnvelope(streamId, entry.chatId, entry.model)
      return new Response(encoder.encode(`data: ${JSON.stringify(done)}\n\n`), {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      })
    }
    // Toujours en cours — le client rappellera
    return new Response(encoder.encode(''), {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    })
  }

  const payload = events.map((env) => `data: ${JSON.stringify(env)}\n\n`).join('')

  return new Response(encoder.encode(payload), {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  })
}

function buildCompleteEnvelope(
  streamId: string,
  chatId: string,
  model: string
): Record<string, unknown> {
  return {
    v: 1,
    type: 'complete',
    seq: 999999,
    ts: new Date().toISOString(),
    stream: { streamId, chatId, cursor: '999999' },
    trace: { requestId: model },
    payload: { status: 'complete', reason: 'stop' },
  }
}
