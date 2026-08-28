FROM node:24-bookworm-slim

WORKDIR /opt/agent-workbench

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY bin ./bin
COPY capabilities ./capabilities
COPY schemas ./schemas
COPY src ./src

ENV NODE_ENV=production
ENTRYPOINT ["node", "/opt/agent-workbench/bin/agent-workbench.js"]
