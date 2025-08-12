import express from 'express'
import axios from 'axios'
import cors from 'cors'

/**
 * Axioma-bot — versión estable
 * - SOLO reacciona a `message_created` (no hace nada en `conversation_created`)
 * - Publica SIEMPRE por API en la conversación existente
 * - Mantiene historial corto por conversación
 */

const app = express()
app.use(express.json({ limit: '1mb' }))

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token', 'api_access_token'],
}))

// === Env ===
const {
  GROQ_API_KEY,
  GROQ_MODEL = 'llama3-70b-8192',
  GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions',

  CHATWOOT_URL = '',
  CHATWOOT_TOKEN = '',
  CHATWOOT_AUTH_MODE = 'xheader', // xheader | query
  CHATWOOT_INBOX_ID = '',         // no se usa si AUTOCREATE=0

  REPLY_VIA_API = '1',
  LOG_BODY = '0',
  LOG_GROQ_RESP = '0',
  LOG_DECISIONS = '0',
  ALLOWED_INBOX_IDS = '',         // ej: "1,3" (vacío = sin filtro)

  CTA_URL = 'https://meet.brevo.com/axioma-creativa-ia/asesoria-flujos-de-trabajo',
  CHATWOOT_AUTOCREATE = '0',      // 0 recomendado con widget
} = process.env

// === Utils ===
function log(...args) { console.log(...args) }
function nowId() { return Math.random().toString(36).slice(2, 10) }
const isTruthy = v => v === 1 || v === '1' || v === true || v === 'true'
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

log('✅ Bot running on port', process.env.PORT || 3000)
log('   Model:', GROQ_MODEL)
log('   GROQ_URL:', GROQ_URL)
log('   REPLY_VIA_API:', isTruthy(REPLY_VIA_API) ? 'ON' : 'OFF')
log('   ALLOWED_INBOX_IDS:', ALLOWED_INBOX_IDS || '(sin filtro)')
log('   AUTOCREATE:', isTruthy(CHATWOOT_AUTOCREATE) ? 'ON' : 'OFF')

// === Dedupe por message.id con TTL ===
const seen = new Map()
const SEEN_TTL_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of seen.entries()) if (now - v > SEEN_TTL_MS) seen.delete(k)
}, 60 * 1000)

// === Memoria corta por conversación ===
const hist = new Map()             // conversationId -> [{role, content, ts}]
const HISTORY_TTL = 15 * 60 * 1000
const HISTORY_MAX = 8
setInterval(() => {
  const now = Date.now()
  for (const [cid, arr] of hist) {
    if (!arr.length || now - arr[arr.length - 1].ts > HISTORY_TTL) hist.delete(cid)
  }
}, 60 * 1000)

// === Intención de precio ===
const PRICE_KEYWORDS = [
  'precio','precios','tarifa','tarifas','coste','costo','cuánto','cuanto',
  'presupuesto','valen','cuesta','cuestan','cotización','cotizacion'
]
const isPriceIntent = (t = '') => PRICE_KEYWORDS.some(k => t.toLowerCase().includes(k))

// === Extractores ===
function extractIncomingText(body) {
  return body?.message?.content
      ?? body?.content
      ?? body?.text
      ?? body?.input
      ?? ''
}
function extractConversationId(body) {
  return body?.conversation?.id
      ?? body?.conversation_id
      ?? body?.id
      ?? null
}
function extractMessageId(body) {
  return body?.message?.id
      ?? body?.id
      ?? null
}
function extractAccountId(body) {
  return body?.account?.id
      ?? body?.account_id
      ?? 1
}
function extractSender(body) {
  return {
    name: body?.message?.sender?.name || 'Visitante',
    email: body?.message?.sender?.email || null,
    phone: body?.message?.sender?.phone_number || null,
  }
}

// === Filtro por inbox permitido ===
function isAllowedInbox(body) {
  const allowed = ALLOWED_INBOX_IDS.split(',').map(s => s.trim()).filter(Boolean)
  const inboxId = body?.inbox?.id || body?.conversation?.inbox_id || body?.message?.inbox_id
  if (!allowed.length) return true
  return allowed.includes(String(inboxId))
}

// === Chatwoot helpers ===
function cwHeaders() {
  const h = { 'Content-Type': 'application/json' }
  if (CHATWOOT_AUTH_MODE === 'xheader') h['api_access_token'] = CHATWOOT_TOKEN
  return h
}
function withToken(url) {
  if (CHATWOOT_AUTH_MODE === 'xheader') return url
  return url + (url.includes('?') ? '&' : '?') + `api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
}
async function postToChatwoot({ accountId, conversationId, content }) {
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
  url = withToken(url)
  return axios.post(url, {
    content,
    message_type: 'outgoing',
    private: false
  }, { headers: cwHeaders(), timeout: 15000 })
}

// >>> NUEVO: abrir conversación (de pending a open) <<<
async function openConversation(accountId, conversationId) {
  try {
    let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/toggle_status`
    url = withToken(url)
    return await axios.post(url, { status: 'open' }, { headers: cwHeaders(), timeout: 15000 })
  } catch (e) {
    log('⚠️ No se pudo abrir la conversación:', e?.response?.status, e?.response?.data || e.message)
  }
}

async function createContactAndConversation(accountId, name, email, phone) {
  // Solo para integraciones sin widget (AUTOCREATE=1)
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/contacts`
  url = withToken(url)
  const c = await axios.post(url, {
    name,
    email: email || undefined,
    phone_number: phone || undefined
  }, { headers: cwHeaders(), timeout: 15000 })
  const contactId = c.data?.id || c.data?.contact?.id
  if (!contactId) throw new Error('No se pudo obtener contact.id')

  url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations`
  url = withToken(url)
  const conv = await axios.post(url, {
    inbox_id: Number(CHATWOOT_INBOX_ID),
    contact_id: Number(contactId),
    status: 'open'
  }, { headers: cwHeaders(), timeout: 15000 })
  const conversationId = conv.data?.id || conv.data?.conversation?.id
  if (!conversationId) throw new Error('No se pudo obtener conversation.id')
  return conversationId
}

// === Rutas ===
app.get('/', (_, res) => res.json({ ok: true, service: 'axioma-bot' }))

app.post('/chat', async (req, res) => {
  const reqId = nowId()
  log(`\n[${reqId}] === Chatwoot webhook ===`)

  if (!req.body) {
    log(`[${reqId}] ❌ Body vacío`)
    return res.status(400).json({ error: 'invalid body' })
  }

  if (!isAllowedInbox(req.body)) {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ inbox no permitido`)
    return res.status(200).json({ ok: true, skipped: true })
  }

  if (isTruthy(LOG_BODY)) {
    log(`[${reqId}] Body:`, JSON.stringify(req.body, null, 2))
  }

  const event = req.body.event || ''
  const accountId = extractAccountId(req.body)

  // SOLO manejamos message_created (no hacemos nada en conversation_created)
  if (event !== 'message_created') {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ evento no manejado: ${event}`)
    return res.status(200).json({ ok: true, skipped: true })
  }

  // Dedupe por message.id
  const mid = extractMessageId(req.body)
  if (mid) {
    if (seen.has(mid)) {
      if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ duplicado msgId=${mid}`)
      return res.status(200).json({ ok: true, deduped: true })
    }
    seen.set(mid, Date.now())
  }

  // Validar que sea entrante de contacto
  const msg = req.body.message || {}
  const typeRaw = msg.message_type ?? req.body.message_type
  const senderTypeRaw = msg.sender_type ?? req.body.sender_type ?? ''
  const isIncoming = typeRaw === 0 || typeRaw === '0' || String(typeRaw).toLowerCase() === 'incoming'
  const isContact = String(senderTypeRaw).toLowerCase() === 'contact' || isIncoming

  if (!isIncoming || !isContact) {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ no es incoming contact`)
    return res.status(200).json({ ok: true, skipped: true })
  }

  // Extraer conversación
  let conversationId = extractConversationId(req.body)
  if (!conversationId) {
    if (isTruthy(CHATWOOT_AUTOCREATE)) {
      // Integraciones sin widget
      try {
        const s = extractSender(req.body)
        if (!s.email) s.email = `sin-email-${Date.now()}@axioma-creativa.local`
        conversationId = await createContactAndConversation(accountId, s.name, s.email, s.phone)
        log(`[${reqId}] 🆕 conv creada (autocreate) id=${conversationId}`)
      } catch (e) {
        log(`[${reqId}] ❌ autocreate falló:`, e?.response?.status, e?.response?.data || e.message)
        return res.status(200).json({ ok: true })
      }
    } else {
      // Con widget: hasta que el usuario no escribe, no hay conversation.id (no hacemos nada)
      if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⚠️ message_created sin conversation.id`)
      return res.status(200).json({ ok: true })
    }
  }

  // Texto del usuario
  const userMessage = extractIncomingText(req.body)
  if (!userMessage) {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⚠️ sin texto entrante`)
    return res.status(200).json({ ok: true })
  }

  // Respuesta inmediata de control (para el webhook)
  res.status(200).json({ ok: true })

  // === Respuesta corta para precios (sin IA) ===
  if (isPriceIntent(userMessage)) {
    const content =
`Gracias por tu interés. Cada proyecto es diferente y requiere entender objetivos, alcance y tiempos.
Para darte un presupuesto serio, mejor agendamos una breve videollamada.
📅 Reserva aquí: ${CTA_URL}
¿Te viene bien esta semana?`
    try {
      await sleep(300) // pequeño delay para evitar carreras
      if (isTruthy(REPLY_VIA_API)) {
        await postToChatwoot({ accountId, conversationId, content })
        await openConversation(accountId, conversationId) // <<< NUEVO
        log(`[${reqId}] ✅ Precio → publicado conv=${conversationId}`)
      }
      const arr = hist.get(conversationId) || []
      arr.push({ role: 'user', content: userMessage, ts: Date.now() })
      arr.push({ role: 'assistant', content, ts: Date.now() })
      hist.set(conversationId, arr.slice(-HISTORY_MAX))
    } catch (e) {
      log(`[${reqId}] ❌ Precio → fallo publicar:`, e?.response?.status, e?.response?.data || e.message)
    }
    return
  }

  // === Flujo normal con GROQ (con historial) ===
  try {
    const prior = hist.get(conversationId) || []
    const messages = [
      {
        role: 'system',
        content:
`Eres un asistente profesional de Axioma Creativa (Madrid).
Estilo: claro, conciso y cercano; evita divagar.
Si preguntan por precios, explica que cada caso requiere entender objetivos, alcance y plazos; invita a agendar videollamada en ${CTA_URL}.
Mantén coherencia con el contexto previo.`
      },
      ...prior.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage }
    ]

    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⇢ GROQ ${GROQ_MODEL}`)
    const g = await axios.post(GROQ_URL, {
      model: GROQ_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 320
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    })

    if (isTruthy(LOG_GROQ_RESP)) log(`[${reqId}] ⇠ GROQ:`, JSON.stringify(g.data, null, 2))

    let botReply = g.data?.choices?.[0]?.message?.content?.trim()
    if (!botReply) botReply = `📅 Agenda aquí: ${CTA_URL}`
    if (!botReply.includes(CTA_URL)) botReply += `\n\n📅 ¿Agendamos? ${CTA_URL}`

    // Publicar en conversación
    if (isTruthy(REPLY_VIA_API)) {
      await sleep(300)
      const resp = await postToChatwoot({ accountId, conversationId, content: botReply })
      await openConversation(accountId, conversationId) // <<< NUEVO
      log(`[${reqId}] ✅ GROQ → publicado status=${resp.status} conv=${conversationId}`)
    }

    // Guardar historial
    const arr = hist.get(conversationId) || []
    arr.push({ role: 'user', content: userMessage, ts: Date.now() })
    arr.push({ role: 'assistant', content: botReply, ts: Date.now() })
    hist.set(conversationId, arr.slice(-HISTORY_MAX))

  } catch (err) {
    const st = err?.response?.status
    const body = err?.response?.data || err.message
    log(`[${reqId}] ❌ GROQ error status=${st} body=${JSON.stringify(body)}`)
    try {
      const fallback = `Ahora mismo estoy saturado 😅. ¿Te va bien agendar una breve videollamada?\n📅 ${CTA_URL}`
      await postToChatwoot({ accountId, conversationId, content: fallback })
      await openConversation(accountId, conversationId) // <<< NUEVO
    } catch {}
  }
})

// Start
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {})
