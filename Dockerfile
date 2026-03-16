FROM node:20-alpine

WORKDIR /app

# Install root deps (pg, googleapis for scripts)
COPY package.json package-lock.json* ./
RUN npm install --production

# Install Teller server deps
COPY teller/package.json teller/package-lock.json* ./teller/
RUN cd teller && npm install --production

# Install Plaid server deps (kept for optional use)
COPY plaid/package.json plaid/package-lock.json* ./plaid/
RUN cd plaid && npm install --production

# Copy source
COPY scripts/ ./scripts/
COPY teller/ ./teller/
COPY plaid/ ./plaid/
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
CMD ["node", "teller/server.js"]
