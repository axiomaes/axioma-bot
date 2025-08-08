# ===== STAGE 1: base =====
FROM node:20-alpine AS base

# Instalar tini para mejor manejo de señales (CTRL+C, docker stop)
RUN apk add --no-cache tini

# Crear carpeta de la app
WORKDIR /app

# Copiar package.json primero (cache de dependencias)
COPY package*.json ./

# Instalar solo producción
RUN npm install --omit=dev

# Copiar el resto del código
COPY . .

# ===== STAGE 2: run =====
FROM node:20-alpine

RUN apk add --no-cache tini

WORKDIR /app

# Copiamos desde la stage base (ya con node_modules instalado)
COPY --from=base /app /app

# Usar tini como entrypoint para manejo de señales
ENTRYPOINT ["/sbin/tini", "--"]

# Variables de entorno por defecto
ENV NODE_ENV=production \
    PORT=3000 \
    LOG_BODY=0 \
    LOG_GROQ_RESP=0 \
    VERIFY_HMAC=0

# Exponer puerto
EXPOSE 3000

# Comando por defecto
CMD ["node", "index.js"]
