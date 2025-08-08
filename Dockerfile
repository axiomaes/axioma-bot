# Usa una imagen base ligera de Node.js
FROM node:20-slim

# Establece el directorio de trabajo dentro del contenedor
WORKDIR /app

# Copia los archivos necesarios para instalar dependencias
COPY package*.json ./

# Instala solo las dependencias necesarias para producción
RUN npm install --omit=dev

# Copia el resto de los archivos al contenedor
COPY . .

# Expone el puerto de la aplicación
EXPOSE 3000

# Comando para iniciar el bot
CMD ["node", "index.js"]
