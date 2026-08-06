FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci
COPY backend backend
RUN npm run build --workspace=@fervor/backend

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/backend/dist backend/dist
COPY db/tools/plane-split.mjs db/tools/plane-split.mjs
COPY db/tools/compose-plane-split.mjs db/tools/compose-plane-split.mjs
COPY db/tools/compose-runtime-bind.mjs db/tools/compose-runtime-bind.mjs
WORKDIR /app/backend
USER node
CMD ["node", "dist/index.js"]
