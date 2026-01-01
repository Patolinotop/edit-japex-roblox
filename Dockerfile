FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
RUN npm install

# baixa browsers dentro da imagem
RUN npx playwright install --with-deps firefox

COPY . .

CMD ["npm", "start"]
