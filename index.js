import express from 'express'
import axios from 'axios'
import cors from 'cors'

const app = express()
app.use(express.json())
app.use(cors())

const GROQ_API_KEY = process.env.GROQ_API_KEY
const MODEL = process.env.GROQ_MODEL || 'mixtral-8x7b-32768'
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
    const response = await axios.post(
      GROQ_URL,
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Eres un asesor comercial de Axioma Creativa, una agencia de marketing y publicidad. Tu objetivo es atraer al visitante, despertar su interés y explicar cómo nuestros servicios pueden ayudarle a impulsar su negocio o marca. Habla de forma cercana, entusiasta y profesional. Destaca que por lanzamiento estamos ofreciendo descuentos especiales y asesoría gratuita. Recomienda nuestros servicios de diseño, branding, marketing digital y desarrollo web, enfocándote en los beneficios concretos para el cliente. Motívalos a dar el siguiente paso para trabajar con nosotros.',
          },
          {
            role: 'user',
            content: message,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    )

    res.json({ response: response.data.choices[0].message.content })
  } catch (error) {
    console.error('❌ Error en la API:', error.response?.data || error.message)
    res.status(500).json({ error: 'Error generating response' })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`)
})
