import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(cors())

const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192'
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY. Configúralo en variables de entorno.')
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'axioma-bot' })
})

app.post('/chat', async (req, res) => {
  const { message } = req.body
  if (!message) {
    return res.status(400).json({ error: 'Message is required' })
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
        { role: 'user', content: message },
      ],
      temperature: 0.8,
      max_tokens: 500,
    }, {
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
    })

    const botReply = response.data.choices[0].message.content
    res.json({ content: botReply }) // ✅ Compatible con Chatwoot
  } catch (error) {
    console.error('❌ Error en la API:', error.response?.data || error.message)
    res.status(500).json({ error: 'Error generating response' })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
})
