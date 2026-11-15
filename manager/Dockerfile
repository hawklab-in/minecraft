FROM node:22-alpine

WORKDIR /app

# Copy dependency specifications
COPY package.json package-lock.json* ./

# Install production dependencies
RUN npm install --omit=dev --no-audit --no-fund

# Copy source code and static assets
COPY . .

# Ensure data directory exists
RUN mkdir -p /data

EXPOSE 3000

CMD ["node", "index.js"]
