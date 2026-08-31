import { db } from '@sim/db'
import { copilotChats } from '@sim/db/schema'
import { eq } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import {
  mothershipChatGetQuerySchema,
  mothershipChatPostEnvelopeSchema,
} from '@/lib/api/contracts/mothership-chats'
import { validationErrorResponse } from '@/lib/api/server'
import { getSession } from '@/lib/auth'
import { chatPubSub } from '@/lib/copilot/chat-status'
import { MOTHERSHIP_CHAT_DEFAULT_MODEL } from '@/lib/copilot/constants'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { runNaoChat } from '@/lib/nao-stream/adapter'
import { GET as copilotChatGet } from '@/app/api/copilot/chat/queries'

export const maxDuration = 3600

// GET — historique des chats (inchangé, délègue à Copilot)
export const GET = withRouteHandler((request: NextRequest) => {
  const validation = mothershipChatGetQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams.entries())
  )
  if (!validation.success) return validationErrorResponse(validation.error)

  return copilotChatGet(request)
})

// POST — envoie un message, utilise nao au lieu de Copilot, et persiste le chat dans le sidebar
export const POST = withRouteHandler(async (request: NextRequest) => {
  const session = await getSession()
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request
    .clone()
    .json()
    .catch(() => undefined)
  if (body !== undefined) {
    const validation = mothershipChatPostEnvelopeSchema.safeParse(body)
    if (!validation.success) return validationErrorResponse(validation.error)
  }

  const message = (body?.message as string) || (body?.message as { text?: string })?.text || ''
  const streamId = (body?.userMessageId as string) || body?.streamId || 'stream-' + Date.now()
  let chatId = (body?.chatId as string) || ''
  const workspaceId =
    (body?.workspaceId as string) || request.nextUrl.searchParams.get('workspaceId') || ''

  // Si nouveau chat sans chatId, créer une entrée copilotChats pour que le sidebar l'affiche
  // On utilise le workspaceId du body ou on fallback sur le premier workspace de l'utilisateur
  let effectiveWorkspaceId = workspaceId
  if (!chatId) {
    if (!effectiveWorkspaceId) {
      // Fallback: chercher le dernier workspace actif de l'utilisateur
      const existing = await db
        .select({ workspaceId: copilotChats.workspaceId })
        .from(copilotChats)
        .where(eq(copilotChats.userId, session.user.id))
        .limit(1)
      effectiveWorkspaceId = existing[0]?.workspaceId || 'f9bc91cc-0105-486b-a389-f8a998a86fe3'
    }
    if (effectiveWorkspaceId) {
      const now = new Date()
      const [chat] = await db
        .insert(copilotChats)
        .values({
          userId: session.user.id,
          workspaceId: effectiveWorkspaceId,
          type: 'mothership',
          title: null,
          model: MOTHERSHIP_CHAT_DEFAULT_MODEL,
          updatedAt: now,
          lastSeenAt: now,
        })
        .returning({ id: copilotChats.id })
      chatId = chat.id
      chatPubSub?.publishStatusChanged({
        workspaceId: effectiveWorkspaceId,
        chatId,
        type: 'created',
      })
    }
  } else if (workspaceId) {
    // S'assurer que le chat existe dans Sim DB (si créé côté Nao directement)
    const existing = await db
      .select({ id: copilotChats.id })
      .from(copilotChats)
      .where(eq(copilotChats.id, chatId))
      .limit(1)
    if (existing.length === 0) {
      const now = new Date()
      await db.insert(copilotChats).values({
        id: chatId,
        userId: session.user.id,
        workspaceId: workspaceId,
        type: 'mothership',
        title: null,
        model: MOTHERSHIP_CHAT_DEFAULT_MODEL,
        updatedAt: now,
        lastSeenAt: now,
      })
    }
  }

  // Transmettre le cookie de session pour l'auth nao et le chatId persistant
  const cookie = request.headers.get('cookie') || undefined
  const projectId = request.headers.get('x-nao-project-id') || undefined

  try {
    const stream = await runNaoChat(message, streamId, cookie, projectId, chatId)
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
        Connection: 'keep-alive',
      },
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
})
