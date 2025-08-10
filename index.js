// index.js — Axioma Bot (tolerante + idempotencia + backoff)
// ------------------------------------------------------------

import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token']
}))

// -------- Entorno --------
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'

const CHATWOOT_URL = process.env.CHATWOOT_URL
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN
const CHATWOOT_AUTH_MODE = (process.env.CHATWOOT_AUTH_MODE || 'xheader').toLowerCase()

const REPLY_VIA_API = process.env.REPLY_VIA_API === '1' // por defecto respondemos SOLO al webhook
const LOG_BODY = process.env.LOG_BODY === '1'
const LOG_GROQ_RESP = process.env.LOG_GROQ_RESP === '1'
const LOG_DECISIONS = process.env.LOG_DECISIONS === '1'

if (!GROQ_API_KEY) console.warn('⚠️ Falta GROQ_API_KEY')

// -------- Utilidades --------
const processed = new Map() // messageId -> ts
const TTL_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of processed.entries()) if (now - v > TTL_MS) processed.delete(k)
}, 60 * 1000)

function log(id, msg) {
  console.log(`[${new Date().toISOString()}] [${id}] ${msg}`)
}

async function callGroqWithRetry(payload, headers, maxAttempts = 3) {
  let delay = 2000
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.post(GROQ_URL, payload, { headers, timeout: 15000 })
    } catch (e) {
      const status = e.response?.status
      const code = e.response?.data?.error?.code
      const retryAfter = Number(e.response?.headers?.['retry-after'])
      const is429 = status === 429 || code === 'rate_limit_exceeded'
      if (!is429 || attempt === maxAttempts) throw e
      const waitMs = (retryAfter ? retryAfter * 1000 : delay) + Math.floor(Math.random() * 500)
      console.warn(`⚠️ Rate limit Groq. Reintento en ${Math.round(waitMs / 1000)}s (${attempt}/${maxAttempts})`)
      await new Promise(r => setTimeout(r, waitMs))
      delay *= 2
    }
  }
}

// Enviar por API (opcional)
async function sendChatwootMessage({ accountId, conversationId, content }) {
  if (!CHATWOOT_URL || !CHATWOOT_TOKEN) throw new Error('CHATWOOT_URL/TOKEN faltan')
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
  const headers = { 'Content-Type': 'application/json' }

  if (CHATWOOT_AUTH_MODE === 'xheader') headers['X-Api-Access-Token'] = CHATWOOT_TOKEN
  else if (CHATWOOT_AUTH_MODE === 'header') headers['api_access_token'] = CHATWOOT_TOKEN
  else if (CHATWOOT_AUTH_MODE === 'bearer') headers['Authorization'] = `Bearer ${CHATWOOT_TOKEN}`
  else { // query
    const sep = url.includes('?') ? '&' : '?'
    url = `${url}${sep}api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  }

  const payload = { content, message_type: 'outgoing', private: false }
  return (await axios.post(url, payload, { headers, timeout: 10000 })).data
}

// -------- Rutas --------
app.get('/', (_, res) => res.json({ ok: true, service: 'axioma-bot' }))

app.post('/chat', async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 10)
  const ip = req.headers['x-forwarded-for'] || req.ip
  log(reqId, `⇢ POST /chat from ${ip}`)

  if (LOG_BODY) {
    console.log(`[${reqId}] ⇢ Headers:`, req.headers)
    console.log(`[${reqId}] ⇢ Body:`, JSON.stringify(req.body, null, 2))
  }

  try {
    const b = req.body || {}

    // ----- Lectura robusta del payload -----
    const event = b.event || b.type
    const msg = b.message || b // a veces viene plano
    const msgId = msg.id
    const msgType = msg.message_type // 'incoming' | 'outgoing' | 0/1
    const isPrivate = msg.private === true
    const senderType = msg.sender_type || b.sender?.type // 'Contact' | 'User' | 'contact'
    const isContact = /contact/i.test((senderType || '').toString())

    // Si no hay message_type, asumimos 'incoming' cuando es contacto y no es privado
    const isIncoming =
      (typeof msgType === 'string' && msgType === 'incoming') ||
      (typeof msgType === 'number' && msgType === 0) ||
      (msgType == null && isContact && !isPrivate)

    // Filtro (tolerante): responder solo a mensajes entrantes de contacto, no privados.
    if (!(isIncoming && !isPrivate && isContact)) {
      if (LOG_DECISIONS) console.log(`[${reqId}] ⏭️  skipped: incoming=${isIncoming} private=${isPrivate} contact=${isContact} event=${event}`)
      return res.status(200).json({ ok: true, skipped: true })
    }

    // Idempotencia
    if (msgId && processed.has(msgId)) {
      if (LOG_DECISIONS) console.log(`[${reqId}] 🔁 dedup message_id=${msgId}`)
      return res.status(200).json({ ok: true, deduped: true })
    }
    if (msgId) processed.set(msgId, Date.now())

    // Texto del usuario
    const userMessage = msg.content || b.content || b.input || b.text || ''
    if (!userMessage.trim()) {
      if (LOG_DECISIONS) console.log(`[${reqId}] ⏭️  no_text`)
      return res.status(200).json({ ok: true, no_text: true })
    }

    const accountId = b.account?.id || b.account_id || 1
    const conversationId = b.conversation?.id || b.conversation_id || 1

    // ----- LLM -----
    log(reqId, `⇢ GROQ model=${MODEL} url=${GROQ_URL}`)
    const payload = {
      model: MODEL,
      messages: [
        { role: 'system', content: 'Eres un asistente alegre de Axioma Creativa. Usa emojis y tono cercano; entiende necesidades y sugiere siguientes pasos.' },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 220
    }

    const groq = await callGroqWithRetry(payload, {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    })

    if (LOG_GROQ_RESP) console.log(`[${reqId}] ⇠ GROQ:`, JSON.stringify(groq.data, null, 2))

    const botReply = groq.data?.choices?.[0]?.message?.content?.trim() || '🙂'
    log(reqId, `⇢ BotReply: ${botReply.slice(0, 140)}${botReply.length > 140 ? '…' : ''}`)

    // ----- Respuesta principal: devolver JSON al webhook -----
    const responsePayload = { content: botReply, private: false }
    // Opcional: publicar por API además (desactivado por defecto)
    if (REPLY_VIA_API) {
      try {
        const r = await sendChatwootMessage({ accountId, conversationId, content: botReply })
        log(reqId, `✅ Chatwoot API ok id=${r?.id || 'n/a'}`)
      } catch (e) {
        console.error(`[${reqId}] ❌ Chatwoot API:`, e.response?.data || e.message)
      }
    }

    return res.status(200).json(responsePayload)
  } catch (err) {
    const status = err.response?.status
    if (status === 429) {
      const msg = '⏳ Dame un segundo, estoy a tope…'
      return res.status(200).json({ content: msg, private: false })
    }
    console.error('[ERR]', err.response?.data || err.message)
    return res.status(200).json({
      content: '😔 Ahora mismo no puedo responder. ¿Lo intentamos en un momento?',
      private: false
    })
  }
})

// -------- Arranque --------
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
  console.log(`   Model: ${MODEL}`)
  console.log(`   GROQ_URL: ${GROQ_URL}`)
  console.log(`   CHATWOOT_AUTH_MODE: ${CHATWOOT_AUTH_MODE}`)
  console.log(`   REPLY_VIA_API: ${REPLY_VIA_API ? 'ON' : 'OFF'}`)
})
