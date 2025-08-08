import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(express.json())

// CORS abierto solo si realmente necesitas exponerlo a frontend directo
app.use(cors({
  origin: '*', // cámbialo por tu dominio si lo usas desde navegador
  methods: ['POST', 'GET', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// Variables de entorno
const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions'

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY. Configúralo en variables de entorno.')
}

// Ruta básica para probar salud
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'axioma-bot' })
})

// Ruta principal que usa Chatwoot u otras apps
app.post('/chat', async (req, res) => {
  // Flexibilidad para aceptar varios tipos de payload
  const userMessage =
    req.body?.message ||
    req.body?.content ||
    req.body?.input ||
    req.body?.text ||
    req.body?.conversation?.messages?.slice(-1)?.content ||
    ''

  if (!userMessage) {
    return res.status(400).json({ error: 'No recibí ningún mensaje para procesar.' })
  }

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

    const botReply = response.data?.choices?.[0]?.message?.content?.trim()

    if (!botReply) {
      return res.status(200).json({ content: '🤖 Lo siento, no pude generar respuesta. ¿Intentamos otra vez?' })
    }

    res.json({ content: botReply }) // ✅ Compatible con Chatwoot
  } catch (error) {
    console.error('❌ Error en la API:', error.response?.data || error.message)
    res.status(200).json({
      content: '⚠️ Ups... Hubo un problema al generar respuesta. ¿Puedes intentarlo en un momento? 😊',
    })
  }
})

// Arranca servidor
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
})
