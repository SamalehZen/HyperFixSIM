// Mini-adaptateur chat : sim (Mothership) → nao OU provider OpenAI-compatible
// MODE 'nao'    : appelle nao /api/agent (protocole AI SDK UI) — outils + rayons HyperFix2
// MODE 'openai' : appelle directement un provider compatible OpenAI (stream chat/completions)

const PORT = Number(process.env.PORT || 8020)
const MODE = (process.env.ADAPTER_MODE || 'nao').toLowerCase()

// --- Backend nao ---
const NAO_BASE_URL = process.env.NAO_BASE_URL || 'http://nao_gamme:5005'
const NAO_EMAIL = process.env.NAO_EMAIL || ''
const NAO_PASSWORD = process.env.NAO_PASSWORD || ''
// Modèle : si NAO_CHAT_MODEL est vide, on omet le champ "model" → nao utilise
// son propre modèle par défaut (changement automatique côté nao).
const NAO_PROVIDER = (process.env.NAO_CHAT_PROVIDER || '').trim()
const NAO_MODEL = (process.env.NAO_CHAT_MODEL || '').trim()
const NAO_MODEL_EXPLICIT = NAO_PROVIDER !== '' && NAO_MODEL !== ''
// Projet nao : requis pour que les chats créés par l'adaptateur aient le bon
// contexte projet (sinon les appels MCP échouent avec mcpAuthRequired).
const NAO_PROJECT_ID = (process.env.NAO_PROJECT_ID || '').trim()

// --- Multi-utilisateur : mapping email sim → (email, password) nao ---
// Format NAO_USERS: "email1:password1,email2:password2"
// Le compte sim (Better Auth) et le compte nao doivent partager la même adresse email.
const NAO_USERS = parseUsers(process.env.NAO_USERS || '')

/** fetch avec timeout (évite tout hang indéfini sur les appels internes) */
async function fetchT(url: string, opts: any, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

function parseUsers(raw: string): Map<string, { email: string; password: string }> {
  const map = new Map<string, { email: string; password: string }>()
  for (const part of raw.split(',')) {
    const [simEmail, password] = part.split(':')
    if (simEmail && password) {
      map.set(simEmail.trim().toLowerCase(), { email: simEmail.trim(), password: password.trim() })
    }
  }
  return map
}

// URL du service simstudio pour valider la session sim (même réseau Docker)
const SIMSTUDIO_URL = process.env.SIMSTUDIO_URL || 'http://simstudio:3000'

// --- Persistance sidebar Sim (copilot_chats) via Postgres direct (Bun SQL) ---
// Le chatId fait foi est le chatId NAO (le client l'adopte et le renvoie ensuite).
// On persiste une row Sim avec le MÊME id pour que le sidebar simstudio l'affiche.
const DATABASE_URL = (process.env.DATABASE_URL || '').trim()
const DEFAULT_WORKSPACE_ID = (
  process.env.SIM_WORKSPACE_ID || 'f9bc91cc-0105-486b-a389-f8a998a86fe3'
).trim()
const simUserIds = new Map<string, string>() // email sim → user id sim

async function persistSimChat(naoChatId: string, simEmail: string, title?: string): Promise<void> {
  if (!DATABASE_URL || !naoChatId || !simEmail) return
  try {
    const { SQL } = await import('bun')
    const db = new SQL(DATABASE_URL)
    // Résoudre l'id utilisateur sim (cache 10 min)
    let userId = simUserIds.get(simEmail)
    if (!userId) {
      const rows = await db`SELECT id FROM "user" WHERE email = ${simEmail} LIMIT 1`.values()
      userId = (rows[0] as string[] | undefined)?.[0]
      if (!userId) return
      simUserIds.set(simEmail, userId)
    }
    if (title) {
      await db`
        INSERT INTO copilot_chats (id, user_id, workspace_id, type, title, model, updated_at, last_seen_at)
        VALUES (${naoChatId}, ${userId}, ${DEFAULT_WORKSPACE_ID}, 'mothership', ${title}, 'mothership', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET title = ${title}, updated_at = NOW()
      `
    } else {
      await db`
        INSERT INTO copilot_chats (id, user_id, workspace_id, type, title, model, updated_at, last_seen_at)
        VALUES (${naoChatId}, ${userId}, ${DEFAULT_WORKSPACE_ID}, 'mothership', NULL, 'mothership', NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
      `
    }
    await db.close()
    console.log(
      `[nao-adapter] chat persisté côté Sim: ${naoChatId} (user ${simEmail}${title ? `, titre "${title}"` : ''})`
    )
  } catch (e) {
    console.warn(`[nao-adapter] persistance Sim ignorée (${naoChatId}):`, (e as Error).message)
  }
}

/** Persiste le tour (message user + réponse assistant) dans copilot_messages Sim
 *  pour que l'historique soit rejouable dans le sidebar uilolo. */
async function persistSimTurn(
  chatId: string,
  simEmail: string,
  streamId: string,
  userText: string,
  assistantText: string,
  toolBlocks?: { id: string; name: string; params?: unknown; output?: unknown; success?: boolean }[]
): Promise<void> {
  if (!DATABASE_URL || !chatId || !simEmail) return
  if (!userText.trim() && !assistantText.trim()) return
  try {
    const { SQL } = await import('bun')
    const db = new SQL(DATABASE_URL)
    let userId = simUserIds.get(simEmail)
    if (!userId) {
      const rows = await db`SELECT id FROM "user" WHERE email = ${simEmail} LIMIT 1`.values()
      userId = (rows[0] as string[] | undefined)?.[0]
      if (!userId) {
        await db.close()
        return
      }
      simUserIds.set(simEmail, userId)
    }
    // seq suivant dans le chat (ordre canonique de lecture: seq asc nulls last)
    const seqRows =
      await db`SELECT COALESCE(MAX(seq), -1) FROM copilot_messages WHERE chat_id = ${chatId}`.values()
    const base = Number((seqRows[0] as unknown[])[0] ?? -1) + 1
    const now = new Date().toISOString()
    if (userText.trim()) {
      const userContent = { id: streamId, role: 'user', content: userText, timestamp: now }
      await db`
        INSERT INTO copilot_messages (chat_id, message_id, role, content, stream_id, seq, created_at, updated_at)
        VALUES (${chatId}, ${streamId}, 'user', ${userContent}, ${streamId}, ${base}, NOW(), NOW())
        ON CONFLICT (chat_id, message_id) DO NOTHING
      `
    }
    if (assistantText.trim()) {
      const aid = crypto.randomUUID()
      const blocks: Record<string, unknown>[] = []
      for (const b of toolBlocks ?? []) {
        if (!b.id) continue
        blocks.push({
          type: 'tool_call',
          toolCall: {
            id: b.id,
            name: b.name,
            state: b.success === false ? 'error' : 'success',
            ...(b.params ? { params: b.params } : {}),
            ...(b.output !== undefined ? { result: { success: b.success !== false, output: b.output } } : {}),
          },
        })
      }
      const asstContent: Record<string, unknown> = {
        id: aid,
        role: 'assistant',
        content: assistantText,
        timestamp: now,
        ...(blocks.length > 0 ? { contentBlocks: blocks } : {}),
      }
      await db`
        INSERT INTO copilot_messages (chat_id, message_id, role, content, stream_id, seq, model, created_at, updated_at)
        VALUES (${chatId}, ${aid}, 'assistant', ${asstContent}, ${streamId}, ${base + 1}, 'nao', NOW(), NOW())
        ON CONFLICT (chat_id, message_id) DO NOTHING
      `
    }
    // Rafraîchir l'ordre du sidebar
    await db`UPDATE copilot_chats SET updated_at = NOW() WHERE id = ${chatId}`
    await db.close()
    console.log(
      `[nao-adapter] tour persisté côté Sim: ${chatId} (user ${userText.length}c, assistant ${assistantText.length}c)`
    )
  } catch (e) {
    console.warn(`[nao-adapter] persistance tour ignorée (${chatId}):`, (e as Error).message)
  }
}

// --- Backend OpenAI-compatible direct ---
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '')
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const OPENAI_MODEL = process.env.OPENAI_MODEL || ''

// --- Store replay (en mémoire) ---
type Entry = {
  chatId: string
  done: boolean
  events: string[]
  lastSeq: number
  replayN: number
  ts: number
}
const store = new Map<string, Entry>()
const TTL_MS = 10 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, e] of store) if (now - e.ts > TTL_MS) store.delete(k)
}, 60_000)

function newEntry(streamId: string): Entry {
  const e: Entry = { chatId: '', done: false, events: [], lastSeq: 0, replayN: 0, ts: Date.now() }
  store.set(streamId, e)
  return e
}

function markDone(streamId: string) {
  const e = store.get(streamId)
  if (e) e.done = true
}

// --- nao : login + session cookie (par utilisateur) ---
const naoCookies = new Map<string, string>()

async function naoLogin(email: string, password: string): Promise<string> {
  const res = await fetchT(
    `${NAO_BASE_URL}/api/auth/sign-in/email`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    },
    15_000
  )
  await res.body?.cancel().catch(() => {})
  if (!res.ok) throw new Error(`nao login ${res.status} pour ${email}`)
  const list = (res.headers as any).getSetCookie
    ? (res.headers as any).getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean)
  const cookie = list.map((c: string) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`nao login: no cookie pour ${email}`)
  return cookie
}

async function getNaoCookie(email: string, password: string, force = false): Promise<string> {
  const key = email.toLowerCase()
  if (force || !naoCookies.has(key)) naoCookies.set(key, await naoLogin(email, password))
  return naoCookies.get(key)!
}

/** Résout (email, password) nao à partir de l'email de la session sim. */
function resolveNaoCreds(simEmail: string): { email: string; password: string } {
  const mapped = NAO_USERS.get((simEmail || '').toLowerCase())
  if (mapped) return { email: mapped.email, password: mapped.password }
  if (NAO_EMAIL && NAO_PASSWORD) return { email: NAO_EMAIL, password: NAO_PASSWORD }
  throw new Error('Aucun compte nao configuré pour cet utilisateur')
}

/** Valide la session sim (cookie Better Auth) et retourne l'email, ou null.
 *  Cache 5 min par cookie pour éviter un aller-retour simstudio (10s) sur chaque message.
 */
const simSessionCache = new Map<string, { email: string; ts: number }>()
const SIM_SESSION_TTL_MS = 5 * 60 * 1000

async function getSimUserEmail(cookieHeader: string | null): Promise<string | null> {
  if (!cookieHeader) return null
  const cached = simSessionCache.get(cookieHeader)
  if (cached && Date.now() - cached.ts < SIM_SESSION_TTL_MS) return cached.email
  try {
    const res = await fetchT(
      `${SIMSTUDIO_URL}/api/auth/get-session`,
      {
        headers: { Cookie: cookieHeader },
      },
      3_000
    )
    if (!res.ok) return cached?.email || null
    const data: any = await res.json().catch(() => null)
    const email = data?.user?.email || null
    if (email) simSessionCache.set(cookieHeader, { email, ts: Date.now() })
    return email
  } catch {
    return cached?.email || null
  }
}

// --- Enveloppe Mothership ---
function envelope(
  type: string,
  payload: unknown,
  seq: number,
  streamId: string,
  chatId: string,
  requestId: string
) {
  return {
    v: 1,
    type,
    seq,
    ts: new Date().toISOString(),
    stream: { streamId, chatId, cursor: String(seq) },
    trace: { requestId },
    payload,
  }
}

// --- Streaming générique : transforme les events backend → Mothership SSE ---
function sseStream(
  streamId: string,
  initialChatId: string,
  consume: (emit: (type: string, payload: unknown) => void) => Promise<void>
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const entry = newEntry(streamId)
  let chatId = initialChatId
  entry.chatId = initialChatId
  const requestId = crypto.randomUUID()
  let seq = 0

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      // Heartbeat immédiat puis toutes les 5s : garde la connexion vivante
      // derrière Caddy/Cloudflare sans 502 (les 15s initiales coupaient le flux)
      try {
        controller.enqueue(enc.encode(': ping\n\n'))
      } catch {
        /* client parti */
      }
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(enc.encode(': ping\n\n'))
        } catch {
          /* client parti */
        }
      }, 5_000)
      // Si le client se déconnecte (Cloudflare, refresh, stop) → on continue à
      // alimenter le STORE (le replay batch reprendra tout) mais sans crasher.
      let clientGone = false
      const safeEnqueue = (chunk: Uint8Array): boolean => {
        if (clientGone) return false
        try {
          controller.enqueue(chunk)
          return true
        } catch {
          clientGone = true
          return false
        }
      }
      const safeClose = () => {
        try {
          controller.close()
        } catch {
          /* déjà fermé */
        }
      }

      const emit = (type: string, payload: unknown) => {
        seq++
        entry.lastSeq = seq
        const full = envelope(type, payload, seq, streamId, chatId, requestId)
        entry.events.push(JSON.stringify(full))
        // Le client peut être parti : le store est TOUJOURS alimenté, l'envoi
        // live est best-effort (le replay batch récupérera tout).
        safeEnqueue(enc.encode(`data: ${JSON.stringify(full)}\n\n`))
      }

      try {
        await consume((type, payload) => {
          if (type === 'session') {
            const p = payload as { chatId?: string }
            if (p?.chatId) {
              chatId = p.chatId
              entry.chatId = chatId
            }
          }
          emit(type, payload)
        })
        console.log(`[nao-adapter] consume terminé — ${seq} events émis (clientGone=${clientGone})`)
        if (!entry.done) {
          emit('complete', { status: 'complete', reason: 'stop' })
          entry.done = true
        }
      } catch (err: any) {
        console.error(`[nao-adapter] ERREUR stream:`, err?.message || err)
        const msg = err?.message || 'adapter error'
        const friendly = /aborted|timed out|timeout/i.test(msg)
          ? "L'agent nao a mis trop de temps à répondre (requête lourde ou LLM saturé). Réessaie dans un instant."
          : msg
        emit('error', { error: friendly })
        entry.done = true
      } finally {
        clearInterval(heartbeat)
        safeClose()
      }
    },
  })
}

// --- Backend nao : AI SDK UI → Mothership ---
// Retourne le chatId final (résolu depuis data-newChat pour un chat neuf)
async function consumeNao(
  text: string,
  streamId: string,
  chatId: string,
  emit: (type: string, payload: unknown) => void,
  naoEmail: string,
  naoPassword: string
): Promise<string> {
  let cookie = await getNaoCookie(naoEmail, naoPassword)
  // Continuité de conversation : on transmet le chatId (adopté par sim depuis nao)
  const requestBody: Record<string, unknown> = {
    message: { text },
    timezone: 'Africa/Djibouti',
  }
  if (chatId) requestBody.chatId = chatId
  if (NAO_MODEL_EXPLICIT) {
    requestBody.model = { provider: NAO_PROVIDER, modelId: NAO_MODEL }
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Cookie: '',
  }
  // Contexte projet : obligatoire pour que les appels MCP (gamme-engine) passent
  if (NAO_PROJECT_ID) headers['x-nao-project-id'] = NAO_PROJECT_ID

  const doCall = (c: string) => {
    headers.Cookie = c
    // 10 min max : au-delà, l'agent répond une erreur claire au lieu de hang infini
    return fetchT(
      `${NAO_BASE_URL}/api/agent`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      },
      10 * 60_000
    )
  }

  let res = await doCall(cookie)
  console.log(`[nao-adapter] agent status=${res.status}`)
  if (res.status === 401) {
    cookie = await getNaoCookie(naoEmail, naoPassword, true)
    res = await doCall(cookie)
  }
  if (!res.ok || !res.body)
    throw new Error(`nao agent ${res.status}: ${await res.text().catch(() => '')}`)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let sentSession = false
  let sentComplete = false
  // Suivi des appels d'outils (AI SDK UI tool-input-* / tool-output-*)
  const pendingTools = new Map<
    string,
    { toolName: string; args: string; input?: Record<string, unknown> }
  >()
  // Résolution display_chart → rows execute_sql (survit au delete des pendingTools)
  const sqlResults = new Map<string, { rows: unknown[]; columns: string[] }>()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6).trim()
      if (!raw) continue
      let d: any
      try {
        d = JSON.parse(raw)
      } catch {
        continue
      }
      const t = d?.type as string

      if (t === 'data-newChat') {
        // Nouveau chat uniquement (pas émis quand on continue un chat existant)
        const id = d?.data?.id as string | undefined
        if (id) {
          chatId = id // résout le chatId final pour la persistance du tour
          // Persister la row Sim avec le MÊME id nao (sidebar uilolo) — non bloquant
          void persistSimChat(id, naoEmail, d?.data?.title as string | undefined)
          if (!sentSession) {
            emit('session', { kind: 'chat', chatId: id })
            sentSession = true
          }
        }
      } else if (t === 'data-chatTitleUpdate') {
        // Titre nao généré → met à jour la row Sim (name du sidebar)
        const title = d?.data?.title as string | undefined
        if (title) void persistSimChat(chatId, naoEmail, title)
      } else if (t === 'reasoning-delta') {
        emit('text', { channel: 'thinking', text: d.delta || '' })
      } else if (t === 'text-delta') {
        emit('text', { channel: 'assistant', text: d.delta || '' })
      } else if (t === 'tool-input-start') {
        const id = d?.toolCallId as string
        const toolName = (d?.toolName as string) || 'tool'
        pendingTools.set(id, { toolName, args: '' })
        emit('tool', {
          phase: 'call',
          toolCallId: id,
          toolName,
          executor: 'sim',
          mode: 'sync',
          status: 'executing',
        })
      } else if (t === 'tool-input-delta') {
        const id = d?.toolCallId as string
        const p = pendingTools.get(id)
        if (p) p.args += (d?.delta as string) || ''
      } else if (t === 'tool-input-available') {
        // Arguments complets : on rafraîchit le nom réel (input.tool) si dispo
        const id = d?.toolCallId as string
        const real = d?.input?.tool as string | undefined
        const p = pendingTools.get(id)
        if (p && real) p.toolName = real
        if (p) p.input = d?.input
        // Re-émettre le call avec les arguments complets (le turn model sim
        // stocke payload.arguments → params pour le rendu chart). Pour
        // display_chart on joint DÈS LE CALL les rows execute_sql résolues
        // (l'execute_sql a toujours terminé avant le display_chart), car le
        // reducer sim n'applique arguments que sur la phase call.
        const toolNameNow = p?.toolName || (d?.input?.tool as string) || 'tool'
        let callArgs: unknown = d?.input
        if (toolNameNow === 'display_chart') {
          const cfg = (d?.input ?? {}) as Record<string, unknown>
          const queryId = cfg.query_id as string | undefined
          const sqlEntry = queryId ? sqlResults.get(queryId) : undefined
          callArgs = {
            ...cfg,
            __chartData: sqlEntry?.rows ?? [],
            __chartColumns: sqlEntry?.columns ?? [],
          }
        }
        emit('tool', {
          phase: 'call',
          toolCallId: id,
          toolName: toolNameNow,
          executor: 'sim',
          mode: 'sync',
          status: 'executing',
          arguments: callArgs,
        })
      } else if (t === 'tool-output-available') {
        const id = d?.toolCallId as string
        const p = pendingTools.get(id)
        const toolName = p?.toolName || (d?.toolName as string) || 'tool'
        const output = d?.output
        // execute_sql: output = { data: rows[], columns, id: query_id } — passer
        // l'objet BRUT au front sim (turn model → ToolCallData.result.output)
        // pour que le rendu display_chart résolve query_id → rows.
        const isExecuteSql = toolName === 'execute_sql'
        let outPayload: unknown
        if (
          isExecuteSql &&
          output &&
          typeof output === 'object' &&
          Array.isArray((output as any).data)
        ) {
          outPayload = output
          if (typeof (output as any).id === 'string') {
            if (sqlResults.size > 50) {
              const firstKey = sqlResults.keys().next().value
              if (firstKey !== undefined) sqlResults.delete(firstKey)
            }
            sqlResults.set((output as any).id, {
              rows: (output as any).data,
              columns: (output as any).columns ?? [],
            })
          }
        } else {
          const textOut =
            typeof output === 'string'
              ? output
              : (output?.text ?? output?.content ?? JSON.stringify(output ?? {}).slice(0, 800))
          outPayload = textOut
        }
        // display_chart: le chartData a déjà été joint au call (voir
        // tool-input-available). Le result reste un simple succès.
        if (toolName === 'display_chart') {
          emit('tool', {
            phase: 'result',
            toolCallId: id,
            toolName,
            executor: 'sim',
            mode: 'sync',
            success: true,
            status: 'success',
            output: { success: true },
          })
          pendingTools.delete(id)
          continue
        }
        emit('tool', {
          phase: 'result',
          toolCallId: id,
          toolName,
          executor: 'sim',
          mode: 'sync',
          success: true,
          status: 'success',
          output: outPayload,
        })
        pendingTools.delete(id)
      } else if (t === 'tool-output-error') {
        const id = d?.toolCallId as string
        const p = pendingTools.get(id)
        emit('tool', {
          phase: 'result',
          toolCallId: id,
          toolName: p?.toolName || 'tool',
          executor: 'sim',
          mode: 'sync',
          success: false,
          status: 'error',
          error: d?.errorText || d?.error || 'Erreur outil',
        })
        pendingTools.delete(id)
      } else if (t === 'finish' && !sentComplete) {
        emit('complete', { status: 'complete', reason: 'stop' })
        sentComplete = true
        markDone(streamId)
      } else if (t === 'error') {
        emit('error', { error: d.errorText || d.error || 'Erreur backend' })
        markDone(streamId)
      }
    }
  }
  markDone(streamId)
  console.log(`[nao-adapter] flux terminé — nao user=${naoEmail} chat=${chatId || 'nouveau'}`)
  return chatId
}

// --- Backend OpenAI-compatible : chat/completions stream → Mothership ---
async function consumeOpenAI(
  text: string,
  streamId: string,
  emit: (type: string, payload: unknown) => void
) {
  if (!OPENAI_BASE_URL || !OPENAI_API_KEY)
    throw new Error('OPENAI_BASE_URL / OPENAI_API_KEY manquants dans .env')
  const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      stream: true,
      messages: [{ role: 'user', content: text }],
    }),
  })
  if (!res.ok || !res.body)
    throw new Error(`openai ${res.status}: ${await res.text().catch(() => '')}`)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let sentComplete = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      const raw = line.replace(/^data:\s*/, '').trim()
      if (!raw || raw === '[DONE]') {
        if (raw === '[DONE]' && !sentComplete) {
          emit('complete', { status: 'complete', reason: 'stop' })
          sentComplete = true
          markDone(streamId)
        }
        continue
      }
      let d: any
      try {
        d = JSON.parse(raw)
      } catch {
        continue
      }
      const delta = d?.choices?.[0]?.delta || {}
      if (delta.reasoning_content)
        emit('text', { channel: 'thinking', text: delta.reasoning_content })
      if (delta.content) emit('text', { channel: 'assistant', text: delta.content })
    }
  }
  markDone(streamId)
}

// --- Serveur ---
Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/healthz') return new Response('ok')

    // POST /api/mothership/chat → stream Mothership SSE
    if (url.pathname === '/api/mothership/chat' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}))
      const msgRaw = (body as any)?.message
      const text = typeof msgRaw === 'string' ? msgRaw : (msgRaw?.text ?? '')
      const streamId =
        (body as any)?.userMessageId || (body as any)?.streamId || crypto.randomUUID()
      // Continuité : le client sim renvoie le chatId adopté (qui EST le chatId nao)
      const chatId = ((body as any)?.chatId as string) || ''
      const cookieHeader = req.headers.get('cookie')

      // Persistance sidebar Sim: PAS de création bloquante ici (créait un 400 "No project
      // configured" côté nao car on envoyait un chatId Sim inexistant dans nao). Le chatId
      // fait foi est le chatId NAO : on persiste la row Sim au moment du data-newChat
      // (voir consumeNao → persistSimChat), avec le MÊME id.

      // Résolution session + login DANS le stream → première réponse immédiatement (headers déjà envoyés)
      // Wrapper emit pour capturer le texte assistant (persistance historique Sim)
      let assistantBuf = ''
      const toolBlocks: { id: string; name: string; params?: unknown; output?: unknown; success?: boolean }[] = []
      const consume = async (emitRaw: (type: string, payload: unknown) => void) => {
        const emit = (type: string, payload: unknown) => {
          if (type === 'text') {
            const p = payload as { channel?: string; text?: string }
            if (p?.channel === 'assistant' && typeof p.text === 'string') assistantBuf += p.text
          }
          if (type === 'tool') {
            const p = payload as { phase?: string; toolCallId?: string; toolName?: string; arguments?: unknown; output?: unknown; success?: boolean }
            if (p?.phase === 'call') {
              toolBlocks.push({ id: p.toolCallId ?? '', name: p.toolName ?? '', params: p.arguments })
            } else if (p?.phase === 'result') {
              const last = [...toolBlocks].reverse().find((b) => b.id === (p.toolCallId ?? ''))
              if (last) {
                last.output = p.output
                last.success = p.success
              }
            }
          }
          emitRaw(type, payload)
        }
        console.log(`[nao-adapter] POST ${streamId} — début consume (chat=${chatId || 'nouveau'})`)
        let naoEmail = NAO_EMAIL
        let naoPassword = NAO_PASSWORD
        let simEmail: string | null = null
        if (MODE === 'nao') {
          simEmail = await getSimUserEmail(cookieHeader)
          console.log(`[nao-adapter] session sim: ${simEmail || '(aucune → fallback défaut)'}`)
          if (simEmail) {
            const creds = resolveNaoCreds(simEmail)
            naoEmail = creds.email
            naoPassword = creds.password
          } else if (!NAO_EMAIL) {
            throw new Error('Session sim invalide')
          }
        }
        // Persist/refresh la row Sim (upsert, non bloquant pour nao).
        // Pour un NOUVEAU chat (sans chatId), on attend data-newChat dans consumeNao
        // pour avoir le vrai id nao — persistSimChat est rappelé là-bas.
        if (chatId) void persistSimChat(chatId, naoEmail)
        console.log(`[nao-adapter] login nao: ${naoEmail}`)
        let finalChatId = chatId
        if (MODE === 'openai') {
          await consumeOpenAI(text, streamId, emit)
        } else {
          finalChatId = await consumeNao(text, streamId, chatId, emit, naoEmail, naoPassword)
        }
        // Historique rejouable côté Sim (messages user + assistant)
        void persistSimTurn(
          finalChatId,
          simEmail || naoEmail,
          streamId,
          text,
          assistantBuf,
          toolBlocks.filter((b) => b.name === 'display_chart' || b.name === 'execute_sql')
        )
      }

      const stream = sseStream(streamId, chatId, consume)
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // GET /api/mothership/chat/stream
    //  - ?batch=true  → JSON {success, events:[{eventId,streamId,event}], status, chatId}
    //  - sinon        → SSE live-tail : events après le curseur puis reste OUVERT
    //                   (heartbeats) jusqu'au complete — évite la boucle reconnecting
    if (url.pathname === '/api/mothership/chat/stream' && req.method === 'GET') {
      const streamId = url.searchParams.get('streamId') || ''
      const after = Number(url.searchParams.get('after') || '0') || 0
      const isBatch = url.searchParams.get('batch') === 'true'
      const entry = store.get(streamId)

      if (isBatch) {
        const pending = entry
          ? entry.events.map((s) => JSON.parse(s)).filter((e: any) => Number(e.seq) > after)
          : []
        const events = pending.map((e: any) => ({
          eventId: Number(e.seq),
          streamId,
          event: e,
        }))
        const status = entry?.done ? 'complete' : 'streaming'
        return Response.json({
          success: true,
          events,
          status,
          ...(entry?.chatId ? { chatId: entry.chatId } : {}),
        })
      }

      // Live tail SSE : reste ouvert tant que le flux n'est pas terminé
      const enc = new TextEncoder()
      const startedAt = Date.now()
      const HEARTBEAT_MS = 15_000

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          let sentSeq = after
          let lastBeat = Date.now()
          try {
            // Flux inconnu (expiré ou adaptateur redémarré) → erreur terminal,
            // jamais de boucle infinie côté client
            if (!entry) {
              const full = envelope(
                'error',
                { error: 'Stream inconnu (expiré)' },
                1,
                streamId,
                '',
                'unknown'
              )
              controller.enqueue(enc.encode(`data: ${JSON.stringify(full)}\n\n`))
              return
            }
            while (Date.now() - startedAt < TTL_MS) {
              for (const s of entry.events) {
                const e = JSON.parse(s)
                const seqN = Number(e.seq)
                if (seqN > sentSeq) {
                  controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
                  sentSeq = seqN
                }
              }
              if (entry.done && sentSeq >= entry.lastSeq) break
              if (Date.now() - lastBeat > HEARTBEAT_MS) {
                controller.enqueue(enc.encode(': ping\n\n'))
                lastBeat = Date.now()
              }
              await new Promise((r) => setTimeout(r, 400))
            }
          } catch {
            // client parti ou erreur → fermer proprement
          } finally {
            controller.close()
          }
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    // stop / abort → stub
    if (
      (url.pathname === '/api/mothership/chat/stop' ||
        url.pathname === '/api/mothership/chat/abort') &&
      req.method === 'POST'
    ) {
      return Response.json({})
    }

    return new Response('not found', { status: 404 })
  },
})

console.log(
  `[nao-adapter] écoute :${PORT} — mode=${MODE} backend=${MODE === 'openai' ? `${OPENAI_MODEL}@${OPENAI_BASE_URL || '?'}` : NAO_MODEL_EXPLICIT ? `${NAO_MODEL}@nao` : 'défaut nao (auto)'} projet=${NAO_PROJECT_ID || '(non défini)'}`
)
console.log(`[nao-adapter] multi-user: ${NAO_USERS.size} compte(s) mappé(s)`)
