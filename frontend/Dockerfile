FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY frontend frontend
ARG NEXT_PUBLIC_API_URL=http://localhost:3010/api
ARG NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SOLANA_NETWORK=$NEXT_PUBLIC_SOLANA_NETWORK
RUN npm run build --workspace=@fervor/frontend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3002
WORKDIR /app
COPY --from=build --chown=node:node /app/frontend/.next/standalone ./
COPY --from=build --chown=node:node /app/frontend/.next/static ./frontend/.next/static
COPY --from=build --chown=node:node /app/frontend/public ./frontend/public
WORKDIR /app/frontend
USER node
EXPOSE 3002
CMD ["node", "server.js"]
