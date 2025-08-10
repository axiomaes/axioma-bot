// index.js
import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(express.json())

// CORS abierto
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'api_access_token'],
}))

// ====== ENV ======
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL        = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL     = process.env.GROQ_URL   || 'https://api.groq.com/openai/v1/chat/completions'

// Chatwoot
const CHATWOOT_URL       = process.env.CHATWOOT_URL || '' // ej: https://asistente-chatwoot-web.stacks.axioma-creativa.es
const CHATWOOT_TOKEN     = process.env.CHATWOOT_TOKEN || '' // token personal de usuario/agent (o bot token si tienes uno válido para API)
const CHATWOOT_AUTH_MODE = (process.env.CHATWOOT_AUTH_MODE || 'query').toLowerCase()
// modos soportados: 'query' | 'header' | 'bearer'
// - 'query' usa ?api_access_token=TOKEN  (recomendado si hay dudas con Nginx)
// - 'header' usa header: api_access_token: TOKEN
// - 'bearer' usa header: Authorization: Bearer TOKEN

const LOG_BODY      = process.env.LOG_BODY === '1'
const LOG_GROQ_RESP = process.env.LOG_GROQ_RESP === '1'

// ====== Helpers ======
function pickUserMessage(body) {
  // Prioriza campos típicos de Chatwoot; acepta variantes
  return body?.content
      || body?.message
      || body?.input
      || body?.text
      || ''
}

function pickIds(body) {
  const accountId      = body?.account?.id ?? body?.account_id
  const conversationId = body?.conversation?.id ?? body?.conversation_id
  return { accountId, conversationId }
}

async function sendChatwootMessage({ accountId, conversationId, content }) {
  if (!CHATWOOT_URL) throw new Error('CHATWOOT_URL no definido')
  if (!CHATWOOT_TOKEN) throw new Error('CHATWOOT_TOKEN no definido')
  if (!accountId || !conversationId) throw new Error('Faltan accountId o conversationId')

  const base = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`

  let url = base
  const headers = { 'Content-Type': 'application/json' }

  if (CHATWOOT_AUTH_MODE === 'query') {
    const sep = base.includes('?') ? '&' : '?'
    url = `${base}${sep}api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  } else if (CHATWOOT_AUTH_MODE === 'bearer') {
    headers.Authorization = `Bearer ${CHATWOOT_TOKEN}`
  } else { // 'header'
    headers['api_access_token'] = CHATWOOT_TOKEN
  }

  const payload = {
    content,
    message_type: 'outgoing',
    private: false,
  }

  const resp = await axios.post(url, payload, { headers, timeout: 15000 })
  return resp.data
}

// ====== Rutas ======
app.get('/', (_req, res) => {
  res.json({
    ok: true,
    service: 'axioma-bot',
    model: MODEL,
    chatwoot: {
      url: CHATWOOT_URL || '[unset]',
      auth_mode: CHATWOOT_AUTH_MODE,
      token_present: Boolean(CHATWOOT_TOKEN),
    },
  })
})

app.post('/chat', async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 10)
  const now = new Date().toISOString()
  console.log(`[${now}] [${reqId}] ⇢ POST /chat from ${req.ip} UA="${req.headers['user-agent'] || ''}"`)
  if (LOG_BODY) {
    console.log(`[${reqId}] ⇢ Headers:`, JSON.stringify(req.headers))
    console.log(`[${reqId}] ⇢ Body:`, JSON.stringify(req.body, null, 2))
  }

  // Solo procesamos mensajes nuevos (event: message_created) si viene de Chatwoot,
  // pero no lo exigimos para permitir pruebas con curl.
  const userMessage = pickUserMessage(req.body)
  if (!userMessage) {
    console.log(`[${reqId}] ✱ Sin mensaje en el payload`)
    return res.status(200).json({
      content: '❗️ No recibí ningún mensaje. ¿Puedes escribirlo de nuevo?',
      content_type: 'text',
      private: false,
    })
  }

  if (!GROQ_API_KEY) {
    console.warn(`[${reqId}] ⚠️ Falta GROQ_API_KEY`)
  }

  console.log(`[${reqId}] ⇢ GROQ request → model=${MODEL} url=${GROQ_URL}`)
  try {
    const groqResp = await axios.post(
      GROQ_URL,
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Eres un asistente alegre y amigable de Axioma Creativa. Hablas con emojis, frases cortas y un tono cercano. Tu objetivo es atraer clientes, generar interés y destacar beneficios de servicios creativos (web, contenido, IA). Invita a aprovechar descuentos de lanzamiento cuando encaje.',
          },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.8,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    )

    if (LOG_GROQ_RESP) {
      console.log(`[${reqId}] ⇠ GROQ data:`, JSON.stringify(groqResp.data, null, 2))
    } else {
      console.log(`[${reqId}] ⇠ GROQ status=${groqResp.status}`)
    }

    const botReply = groqResp.data?.choices?.[0]?.message?.content?.trim()
    if (!botReply) {
      console.log(`[${reqId}] ⚠️ Respuesta vacía de GROQ`)
      return res.status(200).json({
        content: '🤖 Estoy aquí, pero no pude generar respuesta. ¿Puedes preguntarme otra vez?',
        content_type: 'text',
        private: false,
      })
    }

    console.log(`[${reqId}] ⇢ BotReply: ${botReply}`)

    // Publicar en Chatwoot si tenemos IDs
    const { accountId, conversationId } = pickIds(req.body)
    if (accountId && conversationId) {
      try {
        const data = await sendChatwootMessage({ accountId, conversationId, content: botReply })
        console.log(`[${reqId}] ✅ Mensaje publicado en Chatwoot (acc=${accountId}, conv=${conversationId}) id=${data?.id ?? '?'}`)
      } catch (err) {
        const e = err?.response?.data || err?.message
        console.error(`[${reqId}] ❌ Error enviando a Chatwoot:`, e)
      }
    } else {
      console.warn(`[${reqId}] ⚠️ payload sin account_id o conversation_id; no se publica en Chatwoot`)
    }

    // Siempre respondemos 200 al webhook
    return res.status(200).json({
      content: botReply,
      content_type: 'text',
      private: false,
    })
  } catch (error) {
    console.error(`[${reqId}] ❌ Error en la API GROQ:`, error?.response?.data || error.message)
    return res.status(200).json({
      content: '😔 Ahora mismo no puedo responder. ¿Intentamos más tarde?',
      content_type: 'text',
      private: false,
    })
  }
})

// ====== Arranque ======
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
  console.log(`   Model: ${MODEL}`)
  console.log(`   GROQ_URL: ${GROQ_URL}`)
  console.log(`   Options: LOG_BODY=${LOG_BODY ? 1 : 0} LOG_GROQ_RESP=${LOG_GROQ_RESP ? 1 : 0}`)
})
