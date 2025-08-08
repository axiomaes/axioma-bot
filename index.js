import express from 'express'
import axios from 'axios'
import cors from 'cors'
import crypto from 'crypto'

// ===== CONFIG =====
const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Chatwoot-Signature'],
}))

// ENV
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'

// Logging toggles
const LOG_BODY = process.env.LOG_BODY === '1'          // loguea el body completo
const LOG_GROQ_RESP = process.env.LOG_GROQ_RESP === '1'// loguea respuesta completa de GROQ
const VERIFY_HMAC = process.env.VERIFY_HMAC === '1'    // verifica firma Chatwoot
const CHATWOOT_BOT_TOKEN = process.env.CHATWOOT_BOT_TOKEN || '' // si usas HMAC

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY. Configúrala en variables de entorno.')
}

// ===== UTILS =====
const now = () => new Date().toISOString()
const rid = () => Math.random().toString(36).slice(2, 10)
const safe = (obj, max = 800) => {
  try {
    const s = typeof obj === 'string' ? obj : JSON.stringify(obj)
    return s.length > max ? s.slice(0, max) + `… (+${s.length - max} chars)` : s
  } catch {
    return '[unserializable]'
  }
}
const truncate = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s)

// HMAC (opcional)
function verifyHmacSignature(req) {
  if (!VERIFY_HMAC) return true
  try {
    const signature = req.header('X-Chatwoot-Signature') || ''
    const body = JSON.stringify(req.body || {})
    const digest = crypto.createHmac('sha256', CHATWOOT_BOT_TOKEN).update(body).digest('hex')
    const ok = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest))
    return ok
  } catch (e) {
    return false
  }
}

// ===== ROUTES =====
app.get('/', (_, res) => {
  res.json({ ok: true, service: 'axioma-bot', time: now() })
})

app.post('/chat', async (req, res) => {
  const reqId = rid()
  const ip = req.headers['x-forwarded-for'] || req.ip
  const ua = req.headers['user-agent'] || ''

  // Log de entrada
  console.log(`[${now()}] [${reqId}] ⇢ POST /chat from ${ip} UA="${ua}"`)
  console.log(`[${now()}] [${reqId}] ⇢ Headers: ${safe({
    'content-type': req.headers['content-type'],
    'x-chatwoot-signature': req.headers['x-chatwoot-signature'] ? '[present]' : '[absent]',
  }, 300)}`)
  if (LOG_BODY) console.log(`[${now()}] [${reqId}] ⇢ Body: ${safe(req.body, 2000)}`)

  // HMAC opcional
  if (!verifyHmacSignature(req)) {
    console.warn(`[${now()}] [${reqId}] ✗ HMAC signature INVALID`)
    // Para no romper el widget, devolvemos 200 con mensaje amable
    return res.status(200).json({
      content: '⚠️ No pude verificar tu solicitud. ¿Puedes intentar nuevamente?',
      private: false,
    })
    // Si prefieres estrictamente 401:
    // return res.status(401).json({ content: 'Firma inválida', private: false })
  }

  // Parse de mensaje
  const userMessage =
    req.body?.message ||
    req.body?.content ||
    req.body?.input ||
    req.body?.text ||
    ''

  if (!userMessage) {
    console.warn(`[${now()}] [${reqId}] ✱ Sin mensaje en el payload`)
    return res.status(200).json({
      content: '❗️ No recibí ningún mensaje para procesar. ¿Puedes escribirlo de nuevo?',
      private: false,
    })
  }

  // Llamada a GROQ
  const t0 = Date.now()
  try {
    console.log(`[${now()}] [${reqId}] ⇢ GROQ request → model=${MODEL} url=${GROQ_URL}`)
    const groqResp = await axios.post(
      GROQ_URL,
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Eres un asistente alegre y amigable de Axioma Creativa. Hablas con emojis, frases cortas, y un tono relajado como si estuvieras en redes sociales. Tu objetivo es atraer clientes, generar interés y destacar los beneficios de los servicios creativos que ofrece Axioma Creativa. Siempre invita a aprovechar descuentos por lanzamiento. Sé divertido, directo y encantador.',
          },
          { role: 'user', content: String(userMessage) },
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
        validateStatus: () => true, // para loguear aunque sea 4xx/5xx
      }
    )
    const dt = Date.now() - t0
    console.log(`[${now()}] [${reqId}] ⇠ GROQ status=${groqResp.status} in ${dt}ms`)

    if (LOG_GROQ_RESP) {
      console.log(`[${now()}] [${reqId}] GROQ raw: ${safe(groqResp.data, 4000)}`)
    }

    if (groqResp.status < 200 || groqResp.status >= 300) {
      console.warn(`[${now()}] [${reqId}] ✗ GROQ non-2xx`)
      return res.status(200).json({
        content: '🤖 Tuve un contratiempo al generar la respuesta. ¿Probamos otra vez?',
        private: false,
      })
    }

    const botReply = groqResp.data?.choices?.[0]?.message?.content?.trim()
    console.log(`[${now()}] [${reqId}] ⇢ BotReply: ${truncate(botReply || '[empty]')}`)

    if (!botReply) {
      return res.status(200).json({
        content: '🤖 Estoy aquí, pero no pude generar respuesta. ¿Puedes preguntarme otra vez?',
        private: false,
      })
    }

    // Respuesta final para Chatwoot
    const payload = {
      content: botReply,
      private: false,
    }
    console.log(`[${now()}] [${reqId}] ✓ Responding 200 with ${safe(payload, 400)}`)
    return res.status(200).json(payload)
  } catch (err) {
    const dt = Date.now() - t0
    const status = err?.response?.status
    const data = err?.response?.data
    console.error(
      `[${now()}] [${reqId}] ✗ GROQ ERROR in ${dt}ms status=${status || 'n/a'} err=${err.message}`
    )
    if (data) console.error(`[${now()}] [${reqId}] ✗ GROQ body: ${safe(data, 1200)}`)

    // Nunca rompemos el widget: siempre content + private:false
    return res.status(200).json({
      content: '😔 Lo siento, ahora mismo no puedo responder. ¿Intentamos más tarde?',
      private: false,
    })
  }
})

// ===== START =====
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
  console.log(`   Model: ${MODEL}`)
  console.log(`   GROQ_URL: ${GROQ_URL}`)
  console.log(`   Options: LOG_BODY=${LOG_BODY?'1':'0'} LOG_GROQ_RESP=${LOG_GROQ_RESP?'1':'0'} VERIFY_HMAC=${VERIFY_HMAC?'1':'0'}`)
})
