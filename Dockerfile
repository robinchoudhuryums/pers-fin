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

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "teller/server.js"]
