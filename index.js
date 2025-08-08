import express from 'express'
import axios from 'axios'
import cors from 'cors'

// // Si usas .env en local, descomenta:
// // import dotenv from 'dotenv'
// // dotenv.config()

const app = express()
app.use(express.json())

// CORS (solo necesario si vas a llamar desde navegador)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// Vars de entorno
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY. Configúrala en variables de entorno.')
}

// Salud
app.get('/', (_, res) => {
  res.json({ ok: true, service: 'axioma-bot' })
})

// Webhook para Chatwoot (y pruebas)
app.post('/chat', async (req, res) => {
  // Acepta distintos campos
  const userMessage =
    req.body?.message ||
    req.body?.content ||
    req.body?.input ||
    req.body?.text ||
    ''

  if (!userMessage) {
    return res.status(200).json({
      content: '❗️ No recibí ningún mensaje para procesar. ¿Puedes escribirlo de nuevo?',
      private: false,
    })
  }

  try {
    const response = await axios.post(
      GROQ_URL,
      {
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
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    )

    const botReply = response.data?.choices?.[0]?.message?.content?.trim()

    if (!botReply) {
      return res.status(200).json({
        content: '🤖 Estoy aquí, pero no pude generar respuesta. ¿Puedes preguntarme otra vez?',
        private: false,
      })
    }

    // ✅ Formato que Chatwoot espera
    return res.status(200).json({
      content: botReply,
      private: false,
    })
  } catch (error) {
    console.error('❌ Error en la API:', error.response?.data || error.message)

    // ✅ Nunca devolvemos {error: ...}; siempre content + private:false
    return res.status(200).json({
      content: '😔 Lo siento, ahora mismo no puedo responder. ¿Intentamos más tarde?',
      private: false,
    })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
})
