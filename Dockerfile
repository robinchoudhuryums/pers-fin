FROM node:20-alpine

WORKDIR /app

# The repo is an npm workspaces project: a single `npm install` at the root
# walks shell/, teller/, and apps/per-sistant/ and installs each workspace's
# deps. Copy all workspace package manifests up front so the install layer
# caches when only source changes.
COPY package.json package-lock.json* ./
COPY shell/package.json shell/package-lock.json* ./shell/
COPY teller/package.json teller/package-lock.json* ./teller/
COPY apps/per-sistant/package.json apps/per-sistant/package-lock.json* ./apps/per-sistant/
COPY plaid/package.json plaid/package-lock.json* ./plaid/

RUN npm install --omit=dev --workspaces --include-workspace-root

# Copy source. The unified shell at shell/index.js is the entry point;
# it require()s teller/ and apps/per-sistant/ as sub-apps and mounts them
# behind a PIN gate. The legacy Plaid app stays for optional standalone use.
COPY shell/ ./shell/
COPY teller/ ./teller/
COPY apps/per-sistant/ ./apps/per-sistant/
COPY plaid/ ./plaid/
COPY scripts/ ./scripts/
COPY db/ ./db/
COPY n8n-workflows/ ./n8n-workflows/
COPY apps-script/ ./apps-script/
COPY docker-entrypoint.sh ./

RUN chmod +x docker-entrypoint.sh

# Run as non-root user for security
RUN addgroup -g 1001 -S appgroup && adduser -u 1001 -S appuser -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

ENTRYPOINT ["./docker-entrypoint.sh"]
# Boot the unified shell — it mounts Perfin (teller) at /perfin and
# Per-sistant at /per-sistant behind a PIN gate. Override with CMD
# ["node", "teller/server.js"] for legacy standalone Perfin.
CMD ["node", "shell/index.js"]
