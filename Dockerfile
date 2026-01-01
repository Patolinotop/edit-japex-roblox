FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# garante browsers no caminho do container
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
RUN npm install

# garante Firefox instalado (mesmo se algo mudar)
RUN npx playwright install --with-deps firefox

COPY . .

CMD ["npm", "start"]
