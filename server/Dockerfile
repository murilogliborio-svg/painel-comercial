# Imagem única, sem etapa de build: o Node 22 executa TypeScript diretamente
# (--experimental-strip-types). Menos peças móveis, menos superfície.
FROM node:22-alpine

# tini garante que SIGTERM chegue ao processo Node e o encerramento seja
# gracioso; sem ele o PID 1 não repassa sinais.
RUN apk add --no-cache tini

WORKDIR /app

# O projeto não tem dependências de runtime obrigatórias. O package.json entra
# antes do código para aproveitar cache de camada quando só o código muda.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || true

COPY src ./src
COPY web ./web

# Diretório de dados. Em hospedagem gerenciada, o disco persistente é montado
# em /var/dados; o dono precisa ser o usuário que roda a aplicação, senão o
# SQLite não consegue criar o arquivo do banco.
RUN mkdir -p /app/data /var/dados && chown -R node:node /app /var/dados

# Não roda como root.
USER node

ENV NODE_ENV=producao \
    HOST=0.0.0.0 \
    PORT=8080

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/saude').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--no-warnings", "--experimental-strip-types", "src/main.ts"]
