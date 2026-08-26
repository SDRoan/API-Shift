# The public diff service. Deliberately does not include anything that scans a
# codebase or talks to GitHub, since neither belongs on a public endpoint.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server/public.js"]
