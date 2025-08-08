import express from 'express'
import axios from 'axios'
import cors from 'cors'

// Configuración opcional de dotenv
// import dotenv from 'dotenv'
// dotenv.config()

const app = express()
app.use(express.json())

// CORS abierto globalmente
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// Variables de entorno
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY. Configúrala en variables de entorno.')
}

// Ruta de prueba
app.get('/', (_, res) => {
  res.json({ ok: true, service: 'axioma-bot' })
})

// Ruta principal
app.post('/chat', async (req, res) => {
  const reqId = Math.random().toString(36).substring(2, 10)
  console.log(`[${new Date().toISOString()}] [${reqId}] ⇢ POST /chat from ${req.ip}`)

  if (process.env.LOG_BODY === '1') {
    console.log(`[${reqId}] ⇢ Headers:`, req.headers)
    console.log(`[${reqId}] ⇢ Body:`, JSON.stringify(req.body, null, 2))
  }

  const userMessage =
    req.body?.message ||
    req.body?.content ||
    req.body?.input ||
    req.body?.text ||
    ''

  if (!userMessage) {
    console.log(`[${reqId}] ⚠️ No se recibió mensaje`)
    return res.status(200).json({
      content: '❗️ No recibí ningún mensaje para procesar. ¿Puedes escribirlo de nuevo?',
      content_type: 'text',
      private: false,
    })
  }

  console.log(`[${reqId}] ⇢ GROQ request → model=${MODEL} url=${GROQ_URL}`)

  try {
    const response = await axios.post(GROQ_URL, {
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Eres un asistente alegre y amigable de Axioma Creativa. Hablas con emojis, frases cortas, y un tono relajado como si estuvieras en redes sociales. Tu objetivo es atraer clientes, generar interés y destacar los beneficios de los servicios creativos que ofrece Axioma Creativa. Siempre invita a aprovechar descuentos por lanzamiento. Sé divertido, directo y encantador.',
        },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.8,
      max_tokens: 500,
    }, {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    })

    console.log(`[${reqId}] ⇠ GROQ status=${response.status}`)

    const botReply = response.data?.choices?.[0]?.message?.content?.trim()

    if (!botReply) {
      console.log(`[${reqId}] ⚠️ Respuesta vacía de GROQ`)
      return res.status(200).json({
        content: '🤖 Estoy aquí, pero no pude generar respuesta. ¿Puedes preguntarme otra vez?',
        content_type: 'text',
        private: false,
      })
    }

    console.log(`[${reqId}] ⇢ BotReply: ${botReply}`)
    return res.status(200).json({
      content: botReply,
      content_type: 'text',
      private: false,
    })
  } catch (error) {
    console.error(`[${reqId}] ❌ Error en la API:`, error.response?.data || error.message)
    return res.status(200).json({
      content: '😔 Lo siento, ahora mismo no puedo responder. ¿Intentamos más tarde?',
      content_type: 'text',
      private: false,
    })
  }
})

// Arranque del servidor
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
})
