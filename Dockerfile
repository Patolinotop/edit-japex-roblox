FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Garante que os browsers estejam presentes (mesmo se o npm trocar algo)
RUN npx playwright install --with-deps firefox

COPY . .

CMD ["node", "index.js"]
