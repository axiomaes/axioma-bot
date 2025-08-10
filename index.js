import express from 'express'
import axios from 'axios'
import cors from 'cors'
import fs from 'fs'

// Cargar JSON de precios
let precios = {}
try {
  precios = JSON.parse(fs.readFileSync('./precios_productos.json', 'utf8'))
  console.log('✅ Archivo precios_productos.json cargado')
} catch (err) {
  console.error('❌ No se pudo cargar precios_productos.json:', err.message)
  precios = {}
}

const app = express()
app.use(express.json({ limit: '1mb' }))

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token'],
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

const isTruthy = v => v === 1 || v === '1' || v === true || v === 'true'

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
  return body?.message?.id ?? body?.id ?? null
}

function extractAccountId(body) {
  return body?.account?.id ?? body?.account_id ?? 1
}

async function postToChatwoot({ accountId, conversationId, content }) {
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
  const headers = { 'Content-Type': 'application/json' }
  if (CHATWOOT_AUTH_MODE === 'xheader') {
    headers['X-Api-Access-Token'] = CHATWOOT_TOKEN
  } else {
    url += (url.includes('?') ? '&' : '?') + `api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  }

  return axios.post(url, {
    content,
    message_type: 'outgoing',
    private: false
  }, { headers, timeout: 15000 })
}

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
  const type = req.body?.message?.message_type ?? req.body?.message_type
  const senderType = (req.body?.message?.sender_type ?? req.body?.sender_type ?? '').toLowerCase()

  const isIncoming = type === 0 || type === '0' || String(type).toLowerCase() === 'incoming'
  const isContact = senderType === 'contact'

  if (isTruthy(LOG_DECISIONS)) {
    log(`[${reqId}] decision: event=${event} isIncoming=${isIncoming} isContact=${isContact}`)
  }

  if (event && event !== 'message_created') {
    return res.status(200).json({ ok: true, skipped: true })
  }
  if (!isIncoming || !isContact) {
    return res.status(200).json({ ok: true, skipped: true })
  }

  const msgId = extractMessageId(req.body)
  if (msgId) {
    if (seen.has(msgId)) {
      return res.status(200).json({ ok: true, deduped: true })
    }
    seen.set(msgId, Date.now())
  }

  const userMessage = extractIncomingText(req.body)
  if (!userMessage) {
    return res.status(200).json({ content: '¿Podrías repetirlo?', private: false })
  }

  // --- Lógica especial: si el usuario pregunta por precios/tarifas ---
  const lowerMsg = userMessage.toLowerCase()
  const buscaPrecio = /(precio|tarifa|cuánto|coste|oferta|promoción|descuento)/.test(lowerMsg)

  if (buscaPrecio && precios.products && precios.products.length) {
    let respuesta = `💡 Estos son nuestros servicios y rangos de precios:\n\n`
    precios.products.forEach(p => {
      respuesta += `📌 **${p.nombre}**\n${p.descripcion}\n💰 ${p.precio.min}€ - ${p.precio.max}€ (${p.precio.unidad})\n\n`
    })
    respuesta += `📅 Durante agosto, septiembre, octubre y noviembre ofrecemos **descuentos personalizados** para cada cliente.\n`
    respuesta += `🔗 Agenda tu asesoría aquí: ${precios.meta?.cta_url || 'https://axioma-creativa.es/contacto'}`

    res.status(200).json({ content: respuesta, private: false })
    return
  }

  // --- Si no es pregunta de precios, usar GROQ ---
  try {
    const g = await axios.post(GROQ_URL, {
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente alegre y amigable de Axioma Creativa. Hablas con emojis, frases cortas y tono cercano. Si el usuario pregunta por precios o tarifas, invítalo a escribir la palabra "precio" para ver la lista completa. Menciona que en agosto, septiembre, octubre y noviembre tenemos descuentos personalizados.'
        },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.8,
      max_tokens: 300
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    })

    const botReply = g.data?.choices?.[0]?.message?.content?.trim()
    if (!botReply) {
      return res.status(200).json({ content: 'Ups, no pude responder ahora 😅', private: false })
    }

    res.status(200).json({ content: botReply, private: false })

    if (isTruthy(REPLY_VIA_API)) {
      const conversationId = extractConversationId(req.body)
      const accountId = extractAccountId(req.body)
      if (!conversationId) return

      try {
        await postToChatwoot({ accountId, conversationId, content: botReply })
      } catch (e) {
        log(`[${reqId}] ❌ Chatwoot POST error:`, e?.response?.status, e?.response?.data)
      }
    }

  } catch (err) {
    res.status(200).json({ content: 'Ahora mismo estoy saturado 😅, ¿probamos de nuevo?', private: false })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {})
