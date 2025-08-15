FROM node:20-bookworm

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
RUN npx playwright install --with-deps

COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["npm","start"]
