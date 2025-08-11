import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  // añadimos también 'api_access_token' por si lo llamas desde navegador
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
  REPLY_VIA_API = '0',
  LOG_BODY = '0',
  LOG_GROQ_RESP = '0',
  LOG_DECISIONS = '0',
} = process.env

function log(...args) { console.log(...args) }
function nowId() { return Math.random().toString(36).slice(2, 10) }

log('✅ Bot running on port', process.env.PORT || 3000)
log('   Model:', GROQ_MODEL)
log('   GROQ_URL:', GROQ_URL)
log('   CHATWOOT_AUTH_MODE:', CHATWOOT_AUTH_MODE)
log('   REPLY_VIA_API:', REPLY_VIA_API === '1' ? 'ON' : 'OFF')

// === Dedupe por message.id con TTL ===
const seen = new Map()
const SEEN_TTL_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of seen.entries()) if (now - v > SEEN_TTL_MS) seen.delete(k)
}, 60 * 1000)

// Helpers
const isTruthy = v => v === 1 || v === '1' || v === true || v === 'true'

// Extractores robustos (top-level o anidado)
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

  // Para tu instancia: usar header api_access_token (no X-Api-Access-Token)
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

// Rutas
app.get('/', (_, res) => res.json({ ok: true, service: 'axioma-bot' }))

app.post('/chat', async (req, res) => {
  const reqId = nowId()
  const ip = req.headers['x-real-ip'] || req.ip
  log(`[${new Date().toISOString()}] [${reqId}] ⇢ POST /chat from ${ip}`)

  if (isTruthy(LOG_BODY)) {
    log(`[${reqId}] ⇢ Headers:`, JSON.stringify(req.headers, null, 2))
    log(`[${reqId}] ⇢ Body:`, JSON.stringify(req.body, null, 2))
  }

  const event = req.body?.event || ''

  // Aceptar message_type/sender_type en message.* o a nivel raíz
  const typeRaw =
    req.body?.message?.message_type ??
    req.body?.message_type

  const senderTypeRaw =
    req.body?.message?.sender_type ??
    req.body?.sender_type ??
    ''

  const typeStr = String(typeRaw).toLowerCase()
  const isIncoming =
    typeRaw === 0 ||
    typeRaw === '0' ||
    typeStr === 'incoming' // 0 | "0" | "incoming"

  // Si no llega sender_type, asumimos contact cuando sea incoming
  const senderType = String(senderTypeRaw).toLowerCase()
  const isContact = senderType ? senderType === 'contact' : isIncoming

  if (isTruthy(LOG_DECISIONS)) {
    log(`[${reqId}] decision: event=${event} isIncoming=${isIncoming} isContact=${isContact}`)
  }

  if (event && event !== 'message_created') {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️  skip: event ${event}`)
    return res.status(200).json({ ok: true, skipped: true })
  }
  if (!isIncoming || !isContact) {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️  skip: not incoming contact`)
    return res.status(200).json({ ok: true, skipped: true })
  }

  // Dedupe
  const msgId = extractMessageId(req.body)
  if (msgId) {
    if (seen.has(msgId)) {
      if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️  duplicate message_id=${msgId}`)
      return res.status(200).json({ ok: true, deduped: true })
    }
    seen.set(msgId, Date.now())
  }

  const userMessage = extractIncomingText(req.body)
  if (!userMessage) {
    log(`[${reqId}] ⚠️ Sin texto entrante`)
    return res.status(200).json({ content: '¿Podrías repetirlo?', private: false })
  }

  // Llama a Groq
  try {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⇢ GROQ model=${GROQ_MODEL} url=${GROQ_URL}`)
    const g = await axios.post(GROQ_URL, {
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente alegre y amigable de Axioma Creativa. Hablas con emojis, frases cortas y tono cercano. Genera interés y guía a la acción, debes mantener coherencia en las conversaciones, si te piden precios hay que explicar que se necesita realizar un estudio del negocio , y eso lo haremos con una videollamada , que pueden solicitar en esta direccion https://meet.brevo.com/axioma-creativa-ia/asesoria-flujos-de-trabajo.'
        },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.8,
      max_tokens: 300
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    })

    if (isTruthy(LOG_GROQ_RESP)) {
      log(`[${reqId}] ⇠ GROQ:`, JSON.stringify(g.data, null, 2))
    } else if (isTruthy(LOG_DECISIONS)) {
      log(`[${reqId}] ⇠ GROQ status=${g.status}`)
    }

    const botReply = g.data?.choices?.[0]?.message?.content?.trim()
    if (!botReply) {
      log(`[${reqId}] ⚠️ Respuesta vacía de GROQ`)
      return res.status(200).json({ content: 'Ups, no pude responder ahora 😅', private: false })
    }

    log(`[${reqId}] ⇢ BotReply: ${botReply.slice(0, 120)}${botReply.length > 120 ? '…' : ''}`)

    // Responder al webhook rápido
    res.status(200).json({ content: botReply, private: false })

    // Publicar en Chatwoot si está activado
    if (isTruthy(REPLY_VIA_API)) {
      const conversationId = extractConversationId(req.body)
      const accountId = extractAccountId(req.body)

      if (!conversationId) {
        log(`[${reqId}] ⚠️ No hay conversation.id en payload → no envío a Chatwoot`)
        return
      }

      try {
        const urlPreview = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
        log(`[${reqId}] ⇢ POST Chatwoot → ${urlPreview} (xheader=${CHATWOOT_AUTH_MODE === 'xheader'})`)

        const resp = await postToChatwoot({
          accountId,
          conversationId,
          content: botReply
        })

        log(`[${reqId}] ⇠ Chatwoot status=${resp.status} id=${resp.data?.id ?? resp.data?.message?.id ?? 'n/a'}`)
      } catch (e) {
        const status = e?.response?.status
        const data = e?.response?.data
        log(`[${reqId}] ❌ Chatwoot POST error status=${status} body=${JSON.stringify(data)}`)
      }
    }

  } catch (err) {
    const status = err?.response?.status
    const data = err?.response?.data || err.message
    log(`[${reqId}] ❌ GROQ error status=${status} body=${JSON.stringify(data)}`)
    // Devolvemos 200 para evitar reintentos infinitos del webhook
    return res.status(200).json({ content: 'Ahora mismo estoy saturado 😅, ¿probamos de nuevo?', private: false })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {})
