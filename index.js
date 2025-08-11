import express from 'express'
import axios from 'axios'
import cors from 'cors'

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
  CHATWOOT_INBOX_ID = '',
  REPLY_VIA_API = '0',
  LOG_BODY = '0',
  LOG_GROQ_RESP = '0',
  LOG_DECISIONS = '0',
  ALLOWED_INBOX_IDS = '', // <-- NUEVO
} = process.env

// === Config conversación y CTA ===
const CTA_URL = 'https://meet.brevo.com/axioma-creativa-ia/asesoria-flujos-de-trabajo'

// Palabras que disparan la intención de precios
const PRICE_KEYWORDS = [
  'precio','precios','tarifa','tarifas','coste','costo','cuánto','cuanto',
  'presupuesto','valen','cuesta','cuestan','cotización','cotizacion'
]
const isPriceIntent = (t = '') => PRICE_KEYWORDS.some(k => t.toLowerCase().includes(k))

// Memoria corta por conversación
const hist = new Map()
const HISTORY_TTL = 15 * 60 * 1000
const HISTORY_MAX = 8
setInterval(() => {
  const now = Date.now()
  for (const [cid, arr] of hist) {
    if (!arr.length || now - arr[arr.length - 1].ts > HISTORY_TTL) hist.delete(cid)
  }
}, 60 * 1000)

// === Utils ===
function log(...args) { console.log(...args) }
function nowId() { return Math.random().toString(36).slice(2, 10) }
const isTruthy = v => v === 1 || v === '1' || v === true || v === 'true'

// NUEVO: filtro por inbox permitido
function isAllowedInbox(body) {
  const allowed = ALLOWED_INBOX_IDS
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  const inboxId = body?.inbox?.id || body?.conversation?.inbox_id || body?.message?.inbox_id;
  if (!allowed.length) return true;
  return allowed.includes(String(inboxId));
}

log('✅ Bot running on port', process.env.PORT || 3000)
log('   Model:', GROQ_MODEL)
log('   GROQ_URL:', GROQ_URL)
log('   CHATWOOT_AUTH_MODE:', CHATWOOT_AUTH_MODE)
log('   REPLY_VIA_API:', REPLY_VIA_API === '1' ? 'ON' : 'OFF')
log('   ALLOWED_INBOX_IDS:', ALLOWED_INBOX_IDS || '(sin filtro)')

// === Dedupe por message.id con TTL ===
const seen = new Map()
const SEEN_TTL_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of seen.entries()) if (now - v > SEEN_TTL_MS) seen.delete(k)
}, 60 * 1000)

// Extractores
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

// POST a Chatwoot
async function postToChatwoot({ accountId, conversationId, content }) {
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
  const headers = { 'Content-Type': 'application/json' }
  if (CHATWOOT_AUTH_MODE === 'xheader') {
    headers['api_access_token'] = CHATWOOT_TOKEN
  } else {
    url += (url.includes('?') ? '&' : '?') + `api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  }
  return axios.post(url, {
    content,
    message_type: 'outgoing',
    private: false
  }, { headers, timeout: 15000 })
}

// Crear contacto y conversación
async function createContactAndConversation(accountId, name, email, phone) {
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/contacts`
  const headers = { 'Content-Type': 'application/json' }
  if (CHATWOOT_AUTH_MODE === 'xheader') {
    headers['api_access_token'] = CHATWOOT_TOKEN
  } else {
    url += `?api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  }
  const contactResp = await axios.post(url, {
    name,
    email,
    phone_number: phone,
    inbox_id: CHATWOOT_INBOX_ID
  }, { headers })
  const contactId = contactResp.data?.id
  if (!contactId) throw new Error('No se pudo obtener contact.id')

  url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations`
  if (CHATWOOT_AUTH_MODE !== 'xheader') {
    url += `?api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  }
  const convResp = await axios.post(url, {
    inbox_id: CHATWOOT_INBOX_ID,
    contact_id: contactId,
    status: 'open'
  }, { headers })
  const conversationId = convResp.data?.id
  if (!conversationId) throw new Error('No se pudo obtener conversation.id')
  return conversationId
}

// === Rutas ===
app.get('/', (_, res) => res.json({ ok: true, service: 'axioma-bot' }))

app.post('/chat', async (req, res) => {
  const reqId = nowId()
  const ip = req.headers['x-real-ip'] || req.ip
  log(`[${new Date().toISOString()}] [${reqId}] ⇢ POST /chat from ${ip}`)

  if (!isAllowedInbox(req.body)) {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ inbox no permitido`);
    return res.status(200).json({ ok: true, skipped: true });
  }

  if (isTruthy(LOG_BODY)) {
    log(`[${reqId}] ⇢ Headers:`, JSON.stringify(req.headers, null, 2))
    log(`[${reqId}] ⇢ Body:`, JSON.stringify(req.body, null, 2))
  }

  const event = req.body?.event || ''
  const typeRaw = req.body?.message?.message_type ?? req.body?.message_type
  const senderTypeRaw = req.body?.message?.sender_type ?? req.body?.sender_type ?? ''
  const typeStr = String(typeRaw).toLowerCase()
  const isIncoming = typeRaw === 0 || typeRaw === '0' || typeStr === 'incoming'
  const senderType = String(senderTypeRaw).toLowerCase()
  const isContact = senderType ? senderType === 'contact' : isIncoming

  if (isTruthy(LOG_DECISIONS)) {
    log(`[${reqId}] decision: event=${event} isIncoming=${isIncoming} isContact=${isContact}`)
  }

  if (event && event !== 'message_created') {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ skip: event ${event}`)
    return res.status(200).json({ ok: true, skipped: true })
  }
  if (!isIncoming || !isContact) {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ skip: not incoming contact`)
    return res.status(200).json({ ok: true, skipped: true })
  }

  // Dedupe
  const msgId = extractMessageId(req.body)
  if (msgId) {
    if (seen.has(msgId)) {
      if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ duplicate message_id=${msgId}`)
      return res.status(200).json({ ok: true, deduped: true })
    }
    seen.set(msgId, Date.now())
  }

  const userMessage = extractIncomingText(req.body)
  if (!userMessage) {
    log(`[${reqId}] ⚠️ Sin texto entrante`)
    return res.status(200).json({ content: '¿Podrías repetirlo?', private: false })
  }

  // --- Respuesta especial para precios ---
  if (isPriceIntent(userMessage)) {
    const content =
`Gracias por tu interés. Cada proyecto es diferente y requiere entender objetivos, alcance y tiempos.
Para darte un presupuesto serio, mejor agendamos una breve videollamada.
📅 Reserva aquí: ${CTA_URL}
¿Te viene bien esta semana?`
    res.status(200).json({ content, private: false })

    if (isTruthy(REPLY_VIA_API)) {
      let conversationId = extractConversationId(req.body)
      const accountId = extractAccountId(req.body)
      if (!conversationId) {
        try {
          const name = req.body?.message?.sender?.name || 'Visitante'
          let email = req.body?.message?.sender?.email
          if (!email) email = `sin-email-${Date.now()}@axioma-creativa.local`
          const phone = req.body?.message?.sender?.phone_number || ''
          conversationId = await createContactAndConversation(accountId, name, email, phone)
        } catch (e) {
          log(`[${reqId}] ❌ Error creando conversación: ${e.message}`)
        }
      }
      if (conversationId) {
        try { await postToChatwoot({ accountId, conversationId, content }) } catch {}
      }
    }
    const cid = extractConversationId(req.body)
    if (cid) {
      const arr = hist.get(cid) || []
      arr.push({ role: 'user', content: userMessage, ts: Date.now() })
      arr.push({ role: 'assistant', content, ts: Date.now() })
      hist.set(cid, arr.slice(-HISTORY_MAX))
    }
    return
  }

  // === Llamada a GROQ ===
  try {
    let cid = extractConversationId(req.body)
    const accountId = extractAccountId(req.body)
    if (!cid && isTruthy(REPLY_VIA_API)) {
      try {
        const name = req.body?.message?.sender?.name || 'Visitante'
        let email = req.body?.message?.sender?.email
        if (!email) email = `sin-email-${Date.now()}@axioma-creativa.local`
        const phone = req.body?.message?.sender?.phone_number || ''
        cid = await createContactAndConversation(accountId, name, email, phone)
      } catch (e) {
        log(`[${reqId}] ❌ Error creando conversación: ${e.message}`)
      }
    }
    const prior = cid ? (hist.get(cid) || []) : []
    const messages = [
      {
        role: 'system',
        content:
`Eres un asistente profesional de Axioma Creativa (Madrid).
Estilo: claro, conciso y cercano. Nuestros servicios van enfocados a soluciones IA para pequeñas y medianas empresas , paginas web , bot , procesos , automatizaciones, edicion de videos , avatares
Si preguntan por precios, explica que cada caso requiere entender objetivos, alcance y plazos; invita a agendar videollamada en ${CTA_URL}.
Mantén coherencia con el contexto previo.`
      },
      ...prior.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: userMessage }
    ]
    const g = await axios.post(GROQ_URL, {
      model: GROQ_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 320
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    })
    let botReply = g.data?.choices?.[0]?.message?.content?.trim()
    if (!botReply) botReply = `📅 Agenda aquí: ${CTA_URL}`
    if (!botReply.includes(CTA_URL)) botReply += `\n\n📅 ¿Agendamos? ${CTA_URL}`
    if (cid) {
      const arr = hist.get(cid) || []
      arr.push({ role: 'user', content: userMessage, ts: Date.now() })
      arr.push({ role: 'assistant', content: botReply, ts: Date.now() })
      hist.set(cid, arr.slice(-HISTORY_MAX))
    }
    res.status(200).json({ content: botReply, private: false })
    if (isTruthy(REPLY_VIA_API) && cid) {
      try {
        const resp = await postToChatwoot({
          accountId,
          conversationId: cid,
          content: botReply
        })
        log(`[${reqId}] ⇠ Chatwoot status=${resp.status}`)
      } catch (e) {
        log(`[${reqId}] ❌ Chatwoot POST error: ${e.message}`)
      }
    }
  } catch (err) {
    log(`[${reqId}] ❌ GROQ error: ${err.message}`)
    return res.status(200).json({
      content: 'Ahora mismo estoy saturado 😅, ¿probamos de nuevo?\n📅 ' + CTA_URL,
      private: false
    })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {})
