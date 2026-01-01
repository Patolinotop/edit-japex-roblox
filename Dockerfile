FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# Copia apenas manifests primeiro (cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o resto do projeto
COPY . .

# Variáveis obrigatórias p/ Playwright no container
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Log de saúde
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "process.exit(0)"

# Start direto no node (mais estável que npm start)
CMD ["node", "index.js"]
