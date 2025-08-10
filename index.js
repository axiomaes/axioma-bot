// index.js
import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(express.json());

// CORS abierto
app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token'],
  })
);

// ===== Variables de entorno =====
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192';
const GROQ_URL =
  process.env.GROQ_URL ||
  'https://api.groq.com/openai/v1/chat/completions';

const LOG_BODY = process.env.LOG_BODY === '1';
const LOG_GROQ_RESP = process.env.LOG_GROQ_RESP === '1';
const LOG_DECISIONS = process.env.LOG_DECISIONS === '1';

if (!GROQ_API_KEY) {
  console.warn('⚠️  Falta GROQ_API_KEY en variables de entorno.');
}

app.get('/', (_, res) => {
  res.json({
    ok: true,
    service: 'axioma-bot',
    model: MODEL,
    groq_url: GROQ_URL,
  });
});

// Helper: extraer el texto del usuario desde payloads variados
function extractUserMessage(body) {
  return (
    body?.message?.content ||
    body?.content ||
    body?.text ||
    body?.input ||
    (Array.isArray(body?.conversation?.messages)
      ? body.conversation.messages.at(-1)?.content
      : '') ||
    ''
  );
}

// ===== Ruta principal (webhook Chatwoot) =====
app.post('/chat', async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 10);
  const now = new Date().toISOString();
  console.log(`[${now}] [${reqId}] ⇢ POST /chat from ${req.ip}`);

  if (LOG_BODY) {
    console.log(`[${reqId}] ⇢ Headers:`, req.headers);
    try {
      console.log(
        `[${reqId}] ⇢ Body:`,
        JSON.stringify(req.body, null, 2)
      );
    } catch {}
  }

  // ---------- Filtro robusto para decidir si responder ----------
  const body = req.body;

  // Último mensaje de la conversación (cuando viene agrupado)
  const lastMsg = Array.isArray(body?.conversation?.messages)
    ? body.conversation.messages[body.conversation.messages.length - 1]
    : undefined;

  // Señales de "entrante"
  const isIncoming =
    body?.message_type === 'incoming' ||
    body?.message?.message_type === 'incoming' ||
    lastMsg?.message_type === 'incoming' ||
    lastMsg?.message_type === 0; // Chatwoot usa 0 en modelos internos

  // Privado?
  const isPrivate =
    body?.private === true ||
    body?.message?.private === true ||
    lastMsg?.private === true;

  // Tipo de remitente, si viene
  const senderType =
    body?.sender?.type ||
    body?.message?.sender_type ||
    body?.sender_type ||
    lastMsg?.sender_type;

  // Cuando sabemos que viene de agente/usuario interno, no respondemos
  const knownAgentTypes = ['agent', 'user', 'system'];
  const isFromAgent =
    senderType &&
    knownAgentTypes.includes(String(senderType).toLowerCase());

  // Decisión final: contestar solo si es entrante y no es privado y no es de agente.
  // Si senderType está ausente, asumimos cliente para no saltarnos mensajes del widget.
  const shouldReply = Boolean(isIncoming && !isPrivate && !isFromAgent);

  if (LOG_DECISIONS) {
    console.log(
      `[${reqId}] decision: incoming=${!!isIncoming} private=${!!isPrivate} senderType=${senderType ?? '[absent]'} => shouldReply=${shouldReply}`
    );
  }

  if (!shouldReply) {
    return res.status(200).json({ ok: true, skipped: true });
  }
  // -------------------------------------------------------------

  const userMessage = extractUserMessage(body).trim();
  if (!userMessage) {
    return res.status(200).json({
      content:
        '❗️ No recibí ningún mensaje para procesar. ¿Puedes escribirlo de nuevo?',
      private: false,
    });
  }

  // Llamada a GROQ
  console.log(
    `[${reqId}] ⇢ GROQ model=${MODEL} url=${GROQ_URL}`
  );

  try {
    const groqResp = await axios.post(
      GROQ_URL,
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Eres el asistente de Axioma Creativa. Responde en español, tono cercano y con algunos emojis. Sé conciso (máx. 3–4 frases) y orienta a la acción (CTA claro) o pueden solicitar una cita en esta direccion https://meet.brevo.com/axioma-creativa-ia/asesoria-flujos-de-trabajo.',
          },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 300,
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    if (LOG_GROQ_RESP) {
      console.log(`[${reqId}] ⇠ GROQ:`, JSON.stringify(groqResp.data, null, 2));
    }

    const botReply =
      groqResp?.data?.choices?.[0]?.message?.content?.trim();

    if (!botReply) {
      return res.status(200).json({
        content:
          '🤖 Estoy aquí, pero no pude generar respuesta. ¿Puedes preguntarme otra vez?',
        private: false,
      });
    }

    console.log(`[${reqId}] ⇢ BotReply: ${botReply.slice(0, 120)}…`);
    // Chatwoot espera { content, private }
    return res.status(200).json({
      content: botReply,
      private: false,
    });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error(
      `[${reqId}] ❌ Error GROQ:`,
      status ? `status=${status}` : '',
      data || err.message
    );

    // Mensaje amable en caso de rate-limit / error
    let msg =
      '😔 Lo siento, ahora mismo no puedo responder. ¿Intentamos de nuevo en unos segundos?';
    if (
      data?.error?.code === 'rate_limit_exceeded' ||
      /rate limit/i.test(JSON.stringify(data || ''))
    ) {
      msg =
        '⏳ Vamos un pelín saturados ahora mismo. Intento contestarte en unos segundos, ¿vale?';
    }

    return res.status(200).json({ content: msg, private: false });
  }
});

// Arranque
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✅ Bot running on port', PORT);
  console.log('Model:', MODEL);
  console.log('GROQ_URL:', GROQ_URL);
  console.log('LOG_BODY:', LOG_BODY ? 'ON' : 'OFF');
  console.log('LOG_GROQ_RESP:', LOG_GROQ_RESP ? 'ON' : 'OFF');
  console.log('LOG_DECISIONS:', LOG_DECISIONS ? 'ON' : 'OFF');
});
