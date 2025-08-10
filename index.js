import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token'] }))

// IA (GROQ)
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'

// Chatwoot
const CHATWOOT_URL = process.env.CHATWOOT_URL
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN
const CHATWOOT_AUTH_MODE = (process.env.CHATWOOT_AUTH_MODE || 'xheader').toLowerCase()

if (!GROQ_API_KEY) console.warn('⚠️ Falta GROQ_API_KEY')
if (!CHATWOOT_URL) console.warn('⚠️ Falta CHATWOOT_URL')
if (!CHATWOOT_TOKEN) console.warn('⚠️ Falta CHATWOOT_TOKEN')

// ping
app.get('/', (_, res) => res.json({ ok: true, service: 'axioma-bot' }))

// util: enviar a chatwoot
async function sendChatwootMessage ({ accountId, conversationId, content }) {
  if (!CHATWOOT_URL || !CHATWOOT_TOKEN) throw new Error('CHATWOOT_URL/TOKEN no configurados')
  if (!accountId || !conversationId) throw new Error('Faltan accountId/conversationId')

  let url = `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`
  const headers = { 'Content-Type': 'application/json' }

  // aplica el modo de auth
  if (CHATWOOT_AUTH_MODE === 'xheader') {
    headers['X-Api-Access-Token'] = CHATWOOT_TOKEN
  } else if (CHATWOOT_AUTH_MODE === 'header') {
    headers['api_access_token'] = CHATWOOT_TOKEN
  } else if (CHATWOOT_AUTH_MODE === 'bearer') {
    headers['Authorization'] = `Bearer ${CHATWOOT_TOKEN}`
  } else { // query
    const sep = url.includes('?') ? '&' : '?'
    url = `${url}${sep}api_access_token=${encodeURIComponent(CHATWOOT_TOKEN)}`
  }

  // log seguro
  console.log(`[sendChatwootMessage] mode=${CHATWOOT_AUTH_MODE} url=${url}`)

  const payload = { content, message_type: 'outgoing', private: false }
  const { data } = await axios.post(url, payload, { headers, timeout: 10000 })
  return data
}

// endpoint principal (webhook simulado/real)
app.post('/chat', async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 10)
  const ip = req.headers['x-forwarded-for'] || req.ip
  console.log(`[${new Date().toISOString()}] [${reqId}] ⇢ POST /chat from ${ip}`)

  try {
    // extrae mensaje y metadatos de chatwoot
    const body = req.body || {}
    const userMessage = body.message || body.content || body.input || body.text || ''
    const accountId = body.account?.id || body.account_id || 1
    const conversationId = body.conversation?.id || body.conversation_id || body.conversationId || 1

    if (!userMessage) {
      return res.status(200).json({ content: '❗️ No recibí ningún mensaje.', private: false })
    }

    // llamar a groq
    console.log(`[${reqId}] ⇢ GROQ model=${MODEL} url=${GROQ_URL}`)
    const groq = await axios.post(GROQ_URL, {
      model: MODEL,
      messages: [
        { role: 'system', content: 'Eres un asistente alegre de Axioma Creativa. Usa emojis, tono cercano y enfocado a conversión.' },
        { role: 'user', content: userMessage }
      ],
      temperature: 0.8,
      max_tokens: 500
    }, {
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 15000
    })

    const botReply = groq.data?.choices?.[0]?.message?.content?.trim() || '🙂'
    console.log(`[${reqId}] ⇢ BotReply: ${botReply.slice(0, 140)}${botReply.length > 140 ? '…' : ''}`)

    // enviar a chatwoot
    try {
      const r = await sendChatwootMessage({ accountId, conversationId, content: botReply })
      console.log(`[${reqId}] ✅ Publicado en Chatwoot (acc=${accountId}, conv=${conversationId}) id=${r?.id || 'n/a'}`)
    } catch (e) {
      console.error(`[${reqId}] ❌ Error enviando a Chatwoot:`, e.response?.data || e.message)
    }

    // respuesta al webhook
    return res.status(200).json({ content: botReply, private: false })
  } catch (err) {
    console.error(`[ERR]`, err.response?.data || err.message)
    return res.status(200).json({ content: '😔 Ahora mismo no puedo responder.', private: false })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
  console.log(`   Model: ${MODEL}`)
  console.log(`   GROQ_URL: ${GROQ_URL}`)
  console.log(`   CHATWOOT_AUTH_MODE: ${CHATWOOT_AUTH_MODE}`)
})
