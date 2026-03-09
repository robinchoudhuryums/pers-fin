FROM node:20-alpine

WORKDIR /app

# Install root deps (pg for scripts)
COPY package.json package-lock.json* ./
RUN npm install --production

# Install server deps
COPY plaid/package.json plaid/package-lock.json* ./plaid/
RUN cd plaid && npm install --production

# Copy source
COPY scripts/ ./scripts/
COPY plaid/ ./plaid/
COPY db/ ./db/
COPY n8n-workflows/ ./n8n-workflows/

EXPOSE 3000

CMD ["node", "plaid/server.js"]
