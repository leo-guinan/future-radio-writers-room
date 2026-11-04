FROM node:22-slim
WORKDIR /app
# The showrunner and dressing rooms are git repos; npm needs git to fetch the character-bible package.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production DATA_DIR=/data REPOS_DIR=/data/repos PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY characters ./characters
COPY seed ./seed
COPY gates.json ./gates.json
COPY public ./public
COPY src ./src
COPY cast.json ./cast.json
COPY scenes ./scenes
COPY catalog ./catalog
COPY demo ./demo
COPY assets.json GOALS.md ./
COPY LICENSE ./LICENSE
COPY deploy/entrypoint.sh /usr/local/bin/room-entrypoint
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Seed on first boot only; the seed command refuses to run on a log with history.
# The server mounts the Art Bus Workshop coordinator (/workshop, /api/workshop,
# /mcp). X sign-in needs X_CLIENT_ID, X_CLIENT_SECRET, X_CALLBACK_URL and
# WORKSHOP_SECRET; without them auth routes return 503. For a node replica,
# override the command: npm run workshop:node -- --upstream <coordinator url>.
CMD ["room-entrypoint"]
