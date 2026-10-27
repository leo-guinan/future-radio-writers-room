FROM node:22-slim
WORKDIR /app
# The showrunner and dressing rooms are git repos; gh is optional for publishing.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production DATA_DIR=/data REPOS_DIR=/data/repos PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY characters ./characters
COPY seed ./seed
COPY gates.json ./gates.json
COPY public ./public
COPY src ./src
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Seed on first boot only; the seed command refuses to run on a log with history.
CMD ["sh", "-c", "[ -s /data/events.jsonl ] || npx tsx src/cli.ts seed; npx tsx src/server.ts"]
