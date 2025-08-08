import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(cors())
app.use(express.json())

const GROQ_API_KEY = process.env.GROQ_API_KEY
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const MODEL = process.env.GROQ_MODEL || 'mixtral-8x7b-32768'

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY. Configúralo en variables de entorno.')
}

app.get('/', (_, res) => res.json({ ok: true, service: 'axioma-bot' }))

// Endpoint simple para pruebas manuales
app.post('/chat', async (req, res) => {
  try {
    const userMessage = (req.body.message || '').toString().trim() || 'Hola, ¿en qué puedo ayudarte?'

    const { data } = await axios.post(
      GROQ_URL,
      {
        model: MODEL,
        messages: [{ role: 'user', content: userMessage }],
        temperature: 0.7
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    )

    const reply = data?.choices?.[0]?.message?.content ?? '(sin respuesta)'
    res.json({ reply })
  } catch (err) {
    console.error('❌ Error Groq:', err?.response?.data || err.message)
    res.status(500).json({ error: 'Error interno del bot' })
  }
})

app.listen(3000, () => {
  console.log('🤖 Axioma Bot escuchando en :3000')
})
