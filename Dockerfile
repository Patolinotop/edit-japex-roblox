FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# ENV PRECISA VIR ANTES DO NODE RODAR
ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "index.js"]
