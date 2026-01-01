FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

# garante Firefox compatível com a versão do Playwright instalada
RUN npx playwright install firefox

COPY . .

CMD ["npm", "start"]
