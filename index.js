import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
app.use(express.json());

app.use(
  cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Access-Token'],
  })
);

// ===== ENV =====
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = process.env.GROQ_MODEL || 'llama3-70b-8192';
const GROQ_URL = process.env.GROQ_URL || 'https://api.groq.com/openai/v1/chat/completions';

const CHATWOOT_URL = process.env.CHATWOOT_URL;
const CHATWOOT_TOKEN = process.env.CHATWOOT_TOKEN;
const REPLY_VIA_API = process.env.REPLY_VIA_API === '1';

const LOG_BODY = process.env.LOG_BODY === '1';
const LOG_GROQ_RESP = process.env.LOG_GROQ_RESP === '1';
const LOG_DECISIONS = process.env.LOG_DECISIONS === '1';

if (!GROQ_API_KEY) console.warn('⚠️ Falta GROQ_API_KEY');

// ===== dedupe simple en memoria =====
const respondedMap = new Map(); // key -> timestamp
const DEDUPE_TTL_MS = 2 * 60 * 1000; // 2 min

function dedupeKeyFromPayload(b) {
  // mensaje explícito
  const mid = b?.message?.id || b?.id;
  if (mid) return `mid:${mid}`;
  // último mensaje de la conversación
  const last = Array.isArray(b?.conversation?.messages)
    ? b.conversation.messages[b.conversation.messages.length - 1]
    : undefined;
  if (last?.id) return `convLast:${b?.conversation?.id}:${last.id}`;
  // fallback
  return `conv:${b?.conversation?.id}:ts:${b?.created_at || Date.now()}`;
}

function hasRecentlyResponded(key) {
  const now = Date.now();
  for (const [k, ts] of respondedMap) {
    if (now - ts > DEDUPE_TTL_MS) respondedMap.delete(k);
  }
  if (!key) return false;
  const ts = respondedMap.get(key);
  if (ts && now - ts < DEDUPE_TTL_MS) return true;
  respondedMap.set(key, now);
  return false;
}

// ===== helpers =====
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

function shouldReplyTo(body) {
  const lastMsg = Array.isArray(body?.conversation?.messages)
    ? body.conversation.messages[body.conversation.messages.length - 1]
    : undefined;

  const isIncoming =
    body?.message_type === 'incoming' ||
    body?.message?.message_type === 'incoming' ||
    lastMsg?.message_type === 'incoming' ||
    lastMsg?.message_type === 0;

  const isPrivate =
    body?.private === true ||
    body?.message?.private === true ||
    lastMsg?.private === true;

  const senderType =
    body?.sender?.type ||
    body?.message?.sender_type ||
    body?.sender_type ||
    lastMsg?.sender_type;

  const knownAgentTypes = ['agent', 'user', 'system'];
  const isFromAgent =
    senderType && knownAgentTypes.includes(String(senderType).toLowerCase());

  const decision = Boolean(isIncoming && !isPrivate && !isFromAgent);

  if (LOG_DECISIONS) {
    console.log(
      `[decision] incoming=${!!isIncoming} private=${!!isPrivate} senderType=${senderType ?? '[absent]'} => shouldReply=${decision}`
    );
  }
  return decision;
}

// ===== endpoint de salud =====
app.get('/', (_, res) => {
  res.json({
    ok: true,
    model: MODEL,
    groq_url: GROQ_URL,
    reply_via_api: REPLY_VIA_API,
  });
});

// ===== webhook principal =====
app.post('/chat', async (req, res) => {
  const reqId = Math.random().toString(36).slice(2, 10);
  console.log(`[${new Date().toISOString()}] [${reqId}] ⇢ POST /chat from ${req.ip}`);

  if (LOG_BODY) {
    console.log(`[${reqId}] ⇢ Headers:`, req.headers);
    try {
      console.log(`[${reqId}] ⇢ Body:`, JSON.stringify(req.body, null, 2));
    } catch {}
  }

  const body = req.body;

  // Filtro: solo contestar a entrantes de cliente
  if (!shouldReplyTo(body)) {
    return res.status(200).json({ ok: true, skipped: true });
  }

  // Antiduplicados
  const dkey = dedupeKeyFromPayload(body);
  if (hasRecentlyResponded(dkey)) {
    if (LOG_DECISIONS) console.log(`[${reqId}] ⛔ dedupe skip key=${dkey}`);
    return res.status(200).json({ ok: true, deduped: true });
  }

  const userMessage = extractUserMessage(body).trim();
  if (!userMessage) {
    return res.status(200).json({
      content: '❗️ No recibí ningún mensaje. ¿Puedes repetirlo?',
      private: false,
    });
  }

  // Llamada a GROQ
  console.log(`[${reqId}] ⇢ GROQ model=${MODEL} url=${GROQ_URL}`);
  let botReply = '';
  try {
    const r = await axios.post(
      GROQ_URL,
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Eres el asistente de Axioma Creativa. Responde en español, cálido y claro, con 1–2 emojis máx. Sé conciso (3–4 frases) y cierra con una CTA.',
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
      console.log(`[${reqId}] ⇠ GROQ:`, JSON.stringify(r.data, null, 2));
    }

    botReply = r?.data?.choices?.[0]?.message?.content?.trim() || '';
    if (!botReply) botReply = '🤖 Aquí estoy, ¿puedes reformular tu pregunta?';
    console.log(`[${reqId}] ⇢ BotReply: ${botReply.slice(0, 140)}…`);
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error(`[${reqId}] ❌ Error GROQ:`, status ? `status=${status}` : '', data || err.message);
    if (data?.error?.code === 'rate_limit_exceeded') {
      botReply = '⏳ Vamos con mucha carga. Intento responderte en unos segundos.';
    } else {
      botReply = '😔 Ha ocurrido un problema técnico. ¿Probamos de nuevo en un momento?';
    }
  }

  // 1) Respuesta síncrona (lo que espera Chatwoot Agent Bot)
  //    -> esto debería crear el mensaje en la conversación
  const syncPayload = { content: botReply, private: false };
  // No añadir otros campos para que Chatwoot no se líe
  res.status(200).json(syncPayload);

  // 2) (Opcional) Empujar también por API para asegurar entrega en el widget
  if (REPLY_VIA_API && CHATWOOT_URL && CHATWOOT_TOKEN) {
    try {
      const accountId = body?.account?.id || 1;
      const convId = body?.conversation?.id;
      if (convId) {
        await axios.post(
          `${CHATWOOT_URL}/api/v1/accounts/${accountId}/conversations/${convId}/messages`,
          {
            content: botReply,
            message_type: 'outgoing',
            private: false,
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Api-Access-Token': CHATWOOT_TOKEN,
            },
            timeout: 10000,
          }
        );
        console.log(`[${reqId}] ✓ pushed via Chatwoot API conv=${convId}`);
      } else {
        console.warn(`[${reqId}] ⚠️ no convId para push API`);
      }
    } catch (err) {
      console.error(
        `[${reqId}] ❌ fallo push API Chatwoot:`,
        err?.response?.status,
        err?.response?.data || err.message
      );
    }
  }
});

// ===== start =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Bot running on port ${PORT}`);
  console.log('Model:', MODEL);
  console.log('GROQ_URL:', GROQ_URL);
  console.log('REPLY_VIA_API:', REPLY_VIA_API ? 'ON' : 'OFF');
  console.log('LOG_BODY:', LOG_BODY ? 'ON' : 'OFF');
  console.log('LOG_GROQ_RESP:', LOG_GROQ_RESP ? 'ON' : 'OFF');
  console.log('LOG_DECISIONS:', LOG_DECISIONS ? 'ON' : 'OFF');
});
