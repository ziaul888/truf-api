# Production image. Migrations run on start, then the API listens on $PORT.
FROM node:24-slim AS build
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json yarn.lock ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN yarn install --frozen-lockfile
COPY . .
RUN yarn build

FROM node:24-slim
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
# The Prisma CLI (a dev dependency) runs `migrate deploy` on start, so node_modules is copied whole.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json prisma.config.ts ./
EXPOSE 4000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
