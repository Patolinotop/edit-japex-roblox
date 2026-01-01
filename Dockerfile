FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

# garante que o path de browsers seja o do container (ms-playwright)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
RUN npm install

# garante browsers (mesmo se algo mudar)
RUN npx playwright install --with-deps firefox

COPY . .

CMD ["npm", "start"]
