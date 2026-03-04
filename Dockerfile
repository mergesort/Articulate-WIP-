FROM node:20-bookworm-slim

ARG MONOLITH_VERSION=v2.10.1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://github.com/Y2Z/monolith/releases/download/${MONOLITH_VERSION}/monolith-gnu-linux-x86_64" \
    -o /usr/local/bin/monolith \
  && chmod +x /usr/local/bin/monolith \
  && /usr/local/bin/monolith -V

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "src/server.js"]
