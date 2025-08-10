// index.js — Axioma Bot para Chatwoot (con filtros, idempotencia y backoff)
// ------------------------------------------------------------

import express from 'express'
import axios from 'axios'
import cors from 'cors'

// ---------- Configuración Express ----------
const app = express()
app.use(express.json())
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token']
}))

// ---------- Variables de entorno ----------
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'

const CHATWOOT_URL = process.env.CHATWOOT_URL
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN
const CHATWOOT_AUTH_MODE = (process.env.CHATWOOT_AUTH_MODE || 'xheader').toLowerCase()

const LOG_BODY = process.env.LOG_BODY === '1'
const LOG_GROQ_RESP = process.env.LOG_GROQ_RESP === '1'

if (!GROQ_API_KEY) console.warn('⚠️ Falta GROQ_API_KEY')
if (!CHATWOOT_URL) console.warn('⚠️ Falta CHATWOOT_URL')
if (!CHATWOOT_TOKEN) console.warn('⚠️ Falta CHATWOOT_TOKEN')

// ---------- Utilidades ----------
const processed = new Map() // messageId -> timestamp
const TTL_MS = 5 * 60 * 1000 // 5 minutos
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of processed.entries()) {
    if (now - v > TTL_MS) processed.delete(k)
  }
}, 60 * 1000)

function logReq(id, msg) {
  console.log(`[${new Date().toISOString()}] [${id}] ${msg}`)
}

// Reintento con backoff para Groq (maneja 429)
async function callGroqWithRetry(payload, headers, maxAttempts = 3) {
  let delay = 2000 // 2s
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.post(GROQ_URL, payload, { headers, timeout: 15000 })
      return resp
    } catch (e) {
      const status = e.response?.status
      const code = e.response?.data?.error?.code
      const retryAfter = Number(e.response?.headers?.['retry-after'])
      const is429 = status === 429 || code === 'rate_limit_exceeded'
      if (!is429 || attempt === maxAttempts) throw e
      const waitMs = (retryAfter ? retryAfter * 1000 : delay) + Math.floor(Math.random() * 500)
      console.warn(`⚠️  Rate limit (Groq). Reintento en ${Math.round(waitMs / 1000)}s (intent ${attempt}/${maxAttempts})`)
      await new Promise(r => setTimeout(r, waitMs))
      delay *= 2
    }
  }
}

// Enviar mensaje a Chatwoot con el modo de auth elegido
async function sendChatwootMessage({ accountId, conversationId, content }) {
  if (!CHATWOOT_URL || !CHATWOOT_TOKEN) throw new Error('CHATWOOT_URL/TOKEN no configurados')
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
  const headers = { 'Content-Type': 'application/json' }

  if (CHATWOOT_AUTH_MODE === 'xheader') {
    headers['X-Api-Access-Token'] = CHATWOOT_TOKEN
  } else if (CHATWOOT_AUTH_MODE === 'header') {
    headers['api_access_token'] = CHATWOOT_TOKEN
  } else if (CHATWOOT_AUTH_MODE === 'bearer') {
    headers['Authorization'] = `Bearer ${CHATWOOT_TOKEN}`
  } else { // query (fallback)
    const sep = url.includes('?') ? '&' : '?'
    url = `${url}${sep}api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  }

  console.log(`[sendChatwootMessage] mode=${CHATWOOT_AUTH_MODE} url=${url}`)
  const payload = { content, message_type: 'outgoing', private: false }
  const { data } = await axios.post(url, payload, { headers, timeout: 10000 })
  return data
}

// ---------- Rutas ----------
app.get('/', (_, res) => res.json({ ok: true, service: 'axioma-bot' }))

app.post('/chat', async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 10)
  const ip = req.headers['x-forwarded-for'] || req.ip
  logReq(reqId, `⇢ POST /chat from ${ip}`)

  if (LOG_BODY) {
    console.log(`[${reqId}] ⇢ Headers:`, req.headers)
    console.log(`[${reqId}] ⇢ Body:`, JSON.stringify(req.body, null, 2))
  }

  try {
    const b = req.body || {}

    // ---- Filtros de evento (evitar múltiples respuestas) ----
    const event = b.event || b.type
    const msgId = b.id || b.message_id || b.message?.id
    const msgType = b.message_type || b.message?.message_type // 'incoming'/'outgoing'
    const isPrivate = b.private === true || b.message?.private === true
    const senderType = b.sender?.type || b.message?.sender_type // 'contact'/'Contact'

    // Solo responder a mensajes entrantes del contacto (no privados)
    if (event !== 'message_created' || msgType !== 'incoming' || isPrivate || !/contact/i.test(senderType || '')) {
      return res.status(200).json({ ok: true, skipped: true })
    }

    // Idempotencia: no procesar el mismo mensaje dos veces
    if (msgId && processed.has(msgId)) {
      return res.status(200).json({ ok: true, deduped: true })
    }
    if (msgId) processed.set(msgId, Date.now())

    // Texto del usuario
    const userMessage = b.message?.content || b.content || b.input || b.text || ''
    if (!userMessage.trim()) {
      return res.status(200).json({ ok: true, no_text: true })
    }

    const accountId = b.account?.id || b.account_id || 1
    const conversationId = b.conversation?.id || b.conversation_id || 1

    // ---- Llamada al modelo (con backoff) ----
    logReq(reqId, `⇢ GROQ model=${MODEL} url=${GROQ_URL}`)

    const payload = {
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: 'Eres un asistente alegre de Axioma Creativa. Usa emojis y tono cercano; enfócate en entender necesidades y proponer próximos pasos claros.'
        },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 220 // controla consumo
    }

    const groqResp = await callGroqWithRetry(payload, {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    })

    if (LOG_GROQ_RESP) {
      console.log(`[${reqId}] ⇠ GROQ:`, JSON.stringify(groqResp.data, null, 2))
    }

    const botReply = groqResp.data?.choices?.[0]?.message?.content?.trim() || '🙂'
    logReq(reqId, `⇢ BotReply: ${botReply.slice(0, 140)}${botReply.length > 140 ? '…' : ''}`)

    // ---- Publicar en Chatwoot ----
    try {
      const r = await sendChatwootMessage({ accountId, conversationId, content: botReply })
      logReq(reqId, `✅ Publicado en Chatwoot (acc=${accountId}, conv=${conversationId}) id=${r?.id || 'n/a'}`)
    } catch (e) {
      console.error(`[${reqId}] ❌ Error enviando a Chatwoot:`, e.response?.data || e.message)
    }

    // Respuesta al webhook
    return res.status(200).json({ content: botReply, private: false })
  } catch (err) {
    const status = err.response?.status
    if (status === 429) {
      const msg = '⏳ Estoy a tope un instante. Vuelvo en unos segundos…'
      try {
        const b = req.body || {}
        const accountId = b.account?.id || b.account_id || 1
        const conversationId = b.conversation?.id || b.conversation_id || 1
        await sendChatwootMessage({ accountId, conversationId, content: msg })
      } catch (_) {}
      return res.status(200).json({ content: msg, private: false })
    }

    console.error('[ERR]', err.response?.data || err.message)
    return res.status(200).json({
      content: '😔 Ahora mismo no puedo responder. ¿Lo intentamos de nuevo en un momento?',
      private: false
    })
  }
})

// ---------- Arranque ----------
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
  console.log(`   Model: ${MODEL}`)
  console.log(`   GROQ_URL: ${GROQ_URL}`)
  console.log(`   CHATWOOT_AUTH_MODE: ${CHATWOOT_AUTH_MODE}`)
})
