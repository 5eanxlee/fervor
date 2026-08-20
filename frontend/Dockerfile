FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY frontend frontend
ARG NEXT_PUBLIC_API_URL=http://localhost:3010/api
ARG NEXT_PUBLIC_SOLANA_NETWORK=mainnet-beta
ARG NEXT_PUBLIC_DATA_MODE=live
ARG NEXT_PUBLIC_REPLAY_MINT=
ARG NEXT_PUBLIC_REPLAY_SYMBOL=REPLAY
ARG NEXT_PUBLIC_REPLAY_NAME=Token
ARG NEXT_PUBLIC_REPLAY_LOGO=
ARG NEXT_PUBLIC_REPLAY_SUPPLY=
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_SOLANA_NETWORK=$NEXT_PUBLIC_SOLANA_NETWORK
ENV NEXT_PUBLIC_DATA_MODE=$NEXT_PUBLIC_DATA_MODE
ENV NEXT_PUBLIC_REPLAY_MINT=$NEXT_PUBLIC_REPLAY_MINT
ENV NEXT_PUBLIC_REPLAY_SYMBOL=$NEXT_PUBLIC_REPLAY_SYMBOL
ENV NEXT_PUBLIC_REPLAY_NAME=$NEXT_PUBLIC_REPLAY_NAME
ENV NEXT_PUBLIC_REPLAY_LOGO=$NEXT_PUBLIC_REPLAY_LOGO
ENV NEXT_PUBLIC_REPLAY_SUPPLY=$NEXT_PUBLIC_REPLAY_SUPPLY
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
