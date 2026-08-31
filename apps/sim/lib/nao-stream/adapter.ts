import { generateId } from '@sim/utils/id'
import { appendEvent, createStream, setStreamDone } from './store'

const NAO_BASE_URL = process.env.NAO_BASE_URL || 'http://nao_gamme:5005'
const NAO_CHAT_MODEL_ID = process.env.NAO_CHAT_MODEL || 'hy3-free'
const NAO_CHAT_PROVIDER = process.env.NAO_CHAT_PROVIDER || 'openaiCompatible/opencode-zen'

const encoder = new TextEncoder()

/**
 * Appelle nao /api/agent et retourne un ReadableStream de SSE Mothership V1
 * directement consommable par le client sim (useChat / processSSEStream).
 *
 * Chaque événement est aussi stocké dans le store en mémoire pour que le
 * GET /api/mothership/chat/stream puisse servir le replay (resume).
 */
export async function runNaoChat(
  message: string,
  streamId: string,
  cookie?: string,
  projectId?: string,
  chatIdParam?: string
): Promise<ReadableStream<Uint8Array>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (cookie) headers['Cookie'] = cookie
  if (projectId) headers['x-nao-project-id'] = projectId

  const body: Record<string, unknown> = {
    message: { text: message },
    model: { provider: NAO_CHAT_PROVIDER, modelId: NAO_CHAT_MODEL_ID },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }
  if (chatIdParam) body.chatId = chatIdParam

  const response = await fetch(`${NAO_BASE_URL}/api/agent`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    cache: 'no-store',
  })

  if (!response.ok) {
    const error = await response.text().catch(() => 'Unknown error')
    throw new Error(`nao API error ${response.status}: ${error}`)
  }

  const requestId = response.headers.get('x-request-id') || generateId()
  let chatId = chatIdParam || ''
  let seq = 0

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      createStream(streamId, chatId, NAO_CHAT_MODEL_ID)

      const send = (event: unknown) => {
        const envelope = event as Record<string, unknown>
        // récupérer le chatId une fois connu pour l'enveloppe
        if (!chatId && envelope.type === 'session') {
          const p = envelope.payload as { chatId?: string } | undefined
          if (p?.chatId) chatId = p.chatId
        }
        seq++
        const full: Record<string, unknown> = {
          v: 1,
          type: envelope.type,
          seq,
          ts: new Date().toISOString(),
          stream: { streamId, chatId, cursor: String(seq) },
          trace: { requestId },
          payload: envelope.payload,
        }
        const data = `data: ${JSON.stringify(full)}\n\n`
        controller.enqueue(encoder.encode(data))
        appendEvent(streamId, { type: 'mothership', data: JSON.stringify(full) })
      }

      // Si on a déjà un chatId persistant (Sim DB), émettre la session immédiatement
      let sentSession = !!chatId
      if (sentSession) {
        send({ type: 'session', payload: { kind: 'chat', chatId } })
      }
      let sentComplete = false

      try {
        const reader = response.body?.getReader()
        if (!reader) throw new Error('No response body')

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6)
            if (!raw.trim()) continue

            let data: Record<string, unknown>
            try {
              data = JSON.parse(raw)
            } catch {
              continue
            }

            const type = data.type as string | undefined

            // data-newChat → récupérer le chatId et émettre session
            if (type === 'data-newChat') {
              const d = data.data as Record<string, unknown> | undefined
              const newChatId = (d?.id as string) || ''
              if (newChatId) chatId = newChatId
              if (!sentSession) {
                send({ type: 'session', payload: { kind: 'chat', chatId } })
                sentSession = true
              }
              continue
            }

            if (type === 'start') continue
            if (type === 'data-newUserMessage') continue
            if (type === 'data-chatTitleUpdate') continue
            if (type === 'start-step') continue
            if (type === 'finish-step') continue
            if (type === 'reasoning-start') continue
            if (type === 'reasoning-end') continue
            if (type === 'text-start') continue
            if (type === 'text-end') continue
            if (type?.startsWith('tool-')) continue
            if (type?.startsWith('data-')) continue

            // reasoning-delta → text (thinking)
            if (type === 'reasoning-delta') {
              const delta = (data.delta as string) || ''
              send({ type: 'text', payload: { channel: 'thinking', text: delta } })
              continue
            }

            // text-delta → text (assistant)
            if (type === 'text-delta') {
              const delta = (data.delta as string) || ''
              send({ type: 'text', payload: { channel: 'assistant', text: delta } })
              continue
            }

            // fin du stream → complete
            if (type === 'finish') {
              if (!sentComplete) {
                send({ type: 'complete', payload: { status: 'complete', reason: 'stop' } })
                sentComplete = true
              }
            }
          }
        }

        // Sécurité : toujours terminer par complete si pas encore envoyé
        if (!sentComplete) {
          send({ type: 'complete', payload: { status: 'complete', reason: 'stop' } })
        }
        setStreamDone(streamId)
        controller.close()
      } catch (err) {
        send({ type: 'error', payload: { error: (err as Error).message } })
        controller.close()
        throw err
      }
    },
  })

  return stream
}
