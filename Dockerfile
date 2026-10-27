# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
ARG APP_BASE_PATH=/dashboardapp
ENV APP_BASE_PATH=${APP_BASE_PATH}
COPY index.html vite.config.js appEnvironment.js ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_BASE_PATH=/dashboardapp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node appEnvironment.js ./appEnvironment.js
COPY --chown=node:node expected_reimbursement_matrix.json ./expected_reimbursement_matrix.json
COPY --chown=node:node server ./server

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "const base=(process.env.APP_BASE_PATH||'').replace(/\\\/$/,''); fetch('http://127.0.0.1:3000'+base+'/api/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "server/index.js"]
