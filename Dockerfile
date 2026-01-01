FROM mcr.microsoft.com/playwright:v1.57.0-jammy

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

RUN npx playwright install firefox

COPY . .

CMD ["npm", "start"]
