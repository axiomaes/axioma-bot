# Usa una imagen base oficial y ligera de Node.js
FROM node:20-slim

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia los archivos necesarios para instalar dependencias
COPY package*.json ./

# Instala solo dependencias de producción
RUN npm install --omit=dev

# Copia el resto del código fuente
COPY . .

# Asegura variables de entorno como producción
ENV NODE_ENV=production

# Expone el puerto que usará CapRover
EXPOSE 3000

# Comando para iniciar el bot
CMD ["node", "index.js"]
