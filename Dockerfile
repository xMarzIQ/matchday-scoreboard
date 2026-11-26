# Small Node image; the app has no npm packages to install.
FROM node:22-alpine

WORKDIR /app
COPY package.json server.js feed.js ./
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
# The match is saved here. Attach a volume at /app/data to keep it through redeploys.
RUN mkdir -p /app/data

EXPOSE 8080
CMD ["node", "server.js"]
