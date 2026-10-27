# Build from the parent directory so the character-bible package (a sibling repo) is in context:
#   docker compose up -d --build        (compose sets context: ..)
# Once the bible tool is on GitHub, point package.json at github:OWNER/future-radio-character-bible
# and the context can go back to this directory.
FROM node:22-slim
WORKDIR /app
# The showrunner and dressing rooms are git repos; gh is optional for publishing.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production DATA_DIR=/data REPOS_DIR=/data/repos PORT=8787
COPY future-radio-character-bible /future-radio-character-bible
COPY future-radio-writers-room/package.json future-radio-writers-room/package-lock.json ./
RUN npm ci --omit=dev
COPY future-radio-writers-room/characters ./characters
COPY future-radio-writers-room/seed ./seed
COPY future-radio-writers-room/gates.json ./gates.json
COPY future-radio-writers-room/public ./public
COPY future-radio-writers-room/src ./src
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Seed on first boot only; the seed command refuses to run on a log with history.
CMD ["sh", "-c", "[ -s /data/events.jsonl ] || npx tsx src/cli.ts seed; npx tsx src/server.ts"]
