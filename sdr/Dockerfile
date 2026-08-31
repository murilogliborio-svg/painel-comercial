# Imagem única, sem etapa de build: o Node 22 executa TypeScript diretamente
# (--experimental-strip-types). Menos peças móveis, menos superfície.
FROM node:22-alpine

# tini garante que SIGTERM chegue ao processo Node e o encerramento seja
# gracioso; sem ele o PID 1 não repassa sinais.
RUN apk add --no-cache tini

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

COPY src ./src
COPY web ./web

RUN mkdir -p /app/data && chown -R node:node /app

# Não roda como root.
USER node

ENV NODE_ENV=producao \
    HOST=0.0.0.0 \
    PORT=8081

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--no-warnings", "--experimental-strip-types", "src/main.ts"]
