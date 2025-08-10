import express from 'express'
import axios from 'axios'
import cors from 'cors'
import fs from 'fs'
import path from 'path'

const app = express()
app.use(express.json({ limit: '1mb' }))

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  // Incluimos api_access_token por si algún cliente lo envía desde navegador
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token', 'api_access_token'],
}))

// === ENV ===
const {
  GROQ_API_KEY,
  GROQ_MODEL = 'llama3-70b-8192',
  GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions',

  CHATWOOT_URL = '',
  CHATWOOT_TOKEN = '',
  CHATWOOT_AUTH_MODE = 'xheader', // xheader | query
  REPLY_VIA_API = '1',

  LOG_BODY = '0',
  LOG_GROQ_RESP = '0',
  LOG_DECISIONS = '0'
} = process.env

function log(...args) { console.log(...args) }
function nowId() { return Math.random().toString(36).slice(2, 10) }

log('✅ Bot running on port', process.env.PORT || 3000)
log('   Model:', GROQ_MODEL)
log('   GROQ_URL:', GROQ_URL)
log('   CHATWOOT_AUTH_MODE:', CHATWOOT_AUTH_MODE)
log('   REPLY_VIA_API:', REPLY_VIA_API === '1' ? 'ON' : 'OFF')

// === Cargar JSON de productos/servicios ===
const pricingPath = path.join(process.cwd(), 'precios_productos.json')
let PRICING = {}
try {
  PRICING = JSON.parse(fs.readFileSync(pricingPath, 'utf8'))
  log('✅ precios_productos.json cargado')
} catch (e) {
  log('⚠️ No se pudo cargar precios_productos.json:', e.message)
  PRICING = { meta: { cta_url: 'https://axioma-creativa.es/contacto' }, products: [] }
}

// === Dedupe por message.id con TTL ===
const seen = new Map()
const SEEN_TTL_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of seen.entries()) if (now - v > SEEN_TTL_MS) seen.delete(k)
}, 60 * 1000)

// === Helpers ===
const isTruthy = v => v === 1 || v === '1' || v === true || v === 'true'

const extractIncomingText = body =>
  body?.message?.content ?? body?.content ?? body?.text ?? body?.input ?? ''

const extractConversationId = body =>
  body?.conversation?.id ?? body?.conversation_id ?? body?.id ?? null

const extractMessageId = body =>
  body?.message?.id ?? body?.id ?? null

const extractAccountId = body =>
  body?.account?.id ?? body?.account_id ?? 1

// Detectar si parece primer mensaje (si Chatwoot adjunta mensajes de la conversación)
function isFirstMessage(body) {
  const msgs = body?.conversation?.messages
  return Array.isArray(msgs) ? msgs.length <= 1 : false
}

// Intención de precio
const PRICE_KEYWORDS = ['precio','precios','tarifa','tarifas','cuánto','cuanto','coste','costo','oferta','promoción','promocion','descuento','presupuesto']
function isPriceQuery(text) {
  const t = (text || '').toLowerCase()
  return PRICE_KEYWORDS.some(k => t.includes(k))
}
function pricingReply() {
  const products = Array.isArray(PRICING.products) ? PRICING.products : []
  if (!products.length) return `Puedo orientarte con precios y opciones. ¿Quieres agendar una llamada?\n\n📅 ${PRICING.meta?.cta_url || ''}`

  let out = '💡 Servicios y rangos orientativos:\n\n'
  for (const p of products) {
    const nombre = p.nombre || p.name || p.id
    const desc = p.descripcion || p.description || ''
    const pr = p.precio || p.price || {}
    const min = pr.min != null ? `${pr.min}€` : ''
    const max = pr.max != null ? `${pr.max}€` : ''
    const unidad = pr.unidad || pr.unit || 'proyecto'
    const rango = (min && max) ? `${min} - ${max}` : (min || max || '')
    out += `• ${nombre}\n${desc}\n💰 ${rango} (${unidad})\n\n`
  }
  out += '🟢 Durante agosto, septiembre, octubre y noviembre ofrecemos **descuentos personalizados** para cada cliente.\n'
  out += `📅 Reserva aquí: ${PRICING.meta?.cta_url || ''}`
  return out
}

// Publicar a Chatwoot
async function postToChatwoot({ accountId, conversationId, content }) {
  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
  const headers = { 'Content-Type': 'application/json' }

  if (CHATWOOT_AUTH_MODE === 'xheader') {
    // Tu instancia acepta este header:
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

  // --- Normalizar tipo de mensaje y remitente ---
  const typeRaw = req.body?.message?.message_type ?? req.body?.message_type
  const typeStr = String(typeRaw).toLowerCase()
  const isIncoming = (typeRaw === 0) || (typeRaw === '0') || (typeStr === 'incoming')

  // Chatwoot a veces NO envía sender_type; si es incoming, asumimos contact
  const senderTypeRaw =
    req.body?.message?.sender_type ??
    req.body?.sender_type ??
    (isIncoming ? 'contact' : '')
  const isContact = String(senderTypeRaw).toLowerCase() === 'contact'

  // Ignorar mensajes de actividad (tipo 3)
  const isActivity = String(typeRaw) === '3' || Number(typeRaw) === 3

  if (isTruthy(LOG_DECISIONS)) {
    log(`[${reqId}] decision: event=${event} isIncoming=${isIncoming} isContact=${isContact} isActivity=${isActivity}`)
  }

  if (event && event !== 'message_created') {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ skip: event ${event}`)
    return res.status(200).json({ ok: true, skipped: true })
  }
  if (isActivity) {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⏭️ skip: activity message`)
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

  // Texto
  const userMessage = extractIncomingText(req.body)
  if (!userMessage) {
    log(`[${reqId}] ⚠️ Sin texto entrante`)
    return res.status(200).json({ content: '¿Podrías repetirlo?', private: false })
  }

  // Presentación automática si parece primer mensaje
  if (isFirstMessage(req.body)) {
    const intro = [
      '👋 Hola, soy el asistente virtual de Axioma Creativa.',
      'Puedo darte precios, promociones y ayudarte con soluciones digitales e IA.',
      'Durante agosto, septiembre, octubre y noviembre tenemos **descuentos personalizados** para cada cliente.',
      `📅 Reserva tu cita: ${PRICING.meta?.cta_url || ''}`
    ].join('\n')
    return res.status(200).json({ content: intro, private: false })
  }

  // Si pregunta por precios → responder con JSON sin llamar a la IA
  if (isPriceQuery(userMessage)) {
    const reply = pricingReply()
    res.status(200).json({ content: reply, private: false })

    if (isTruthy(REPLY_VIA_API)) {
      try {
        const conversationId = extractConversationId(req.body)
        const accountId = extractAccountId(req.body)
        if (conversationId) {
          const resp = await postToChatwoot({ accountId, conversationId, content: reply })
          if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⇠ Chatwoot (pricing) status=${resp.status}`)
        }
      } catch (e) {
        log(`[${reqId}] ❌ Chatwoot POST (pricing) error status=${e?.response?.status} body=${JSON.stringify(e?.response?.data)}`)
      }
    }
    return
  }

  // Llama a Groq para el resto
  try {
    if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⇢ GROQ model=${GROQ_MODEL} url=${GROQ_URL}`)
    const g = await axios.post(GROQ_URL, {
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            'Eres el asistente de Axioma Creativa (Madrid). Tono cercano y profesional, emojis con moderación.',
            'Objetivo: entender la necesidad, responder claro y proponer siguiente acción.',
            'Si preguntan por precios: remite a rangos accesibles y opciones del catálogo.',
            'Evita respuestas largas; usa listas y claridad.',
            'Menciona que durante agosto, septiembre, octubre y noviembre hay **descuentos personalizados**.',
            `Cierra invitando a agendar: ${PRICING.meta?.cta_url || ''}`,
            `Catálogo (resumen): ${JSON.stringify((PRICING.products || []).map(p => ({ nombre: p.nombre, min: p.precio?.min, max: p.precio?.max }))).slice(0, 1800)}`
          ].join(' ')
        },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.6,
      max_tokens: 320
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    })

    const raw = g.data
    if (isTruthy(LOG_GROQ_RESP)) log(`[${reqId}] ⇠ GROQ:`, JSON.stringify(raw, null, 2))
    let botReply = raw?.choices?.[0]?.message?.content?.trim()
    if (!botReply) botReply = 'Puedo ayudarte con ideas y automatizaciones útiles.\n\n📅 Agenda aquí: ' + (PRICING.meta?.cta_url || '')

    // Asegurar CTA
    if (!(botReply.includes(PRICING.meta?.cta_url || ''))) {
      botReply += `\n\n📅 Agenda aquí: ${PRICING.meta?.cta_url || ''}`
    }

    res.status(200).json({ content: botReply, private: false })

    // Publicar en Chatwoot si procede
    if (isTruthy(REPLY_VIA_API)) {
      const conversationId = extractConversationId(req.body)
      const accountId = extractAccountId(req.body)
      if (conversationId) {
        try {
          const resp = await postToChatwoot({ accountId, conversationId, content: botReply })
          if (isTruthy(LOG_DECISIONS)) log(`[${reqId}] ⇠ Chatwoot status=${resp.status} id=${resp.data?.id ?? resp.data?.message?.id ?? 'n/a'}`)
        } catch (e) {
          log(`[${reqId}] ❌ Chatwoot POST error status=${e?.response?.status} body=${JSON.stringify(e?.response?.data)}`)
        }
      } else {
        log(`[${reqId}] ⚠️ No hay conversation.id en payload → no envío a Chatwoot`)
      }
    }

  } catch (err) {
    const status = err?.response?.status
    const data = err?.response?.data || err.message
    log(`[${reqId}] ❌ GROQ error status=${status} body=${JSON.stringify(data)}`)
    return res.status(200).json({
      content: 'Ahora mismo estoy saturado 😅, ¿probamos de nuevo en un momento?\n\n📅 Agenda aquí: ' + (PRICING.meta?.cta_url || ''),
      private: false
    })
  }
})

// Start
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {})
