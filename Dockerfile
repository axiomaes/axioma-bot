# Usa una imagen oficial y ligera de Node.js
FROM node:20-slim

# Define el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia solo los archivos de dependencias primero (mejora la caché de builds)
COPY package*.json ./

# Instala solo dependencias de producción
RUN npm install --omit=dev

# Luego copia el resto del código fuente
COPY . .

# Asegura que el entorno esté en modo producción
ENV NODE_ENV=production

# Expone el puerto esperado por CapRover
EXPOSE 3000

# Comando que arranca el bot
CMD ["node", "index.js"]
