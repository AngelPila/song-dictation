FROM node:22-alpine
WORKDIR /app
COPY server.js .
RUN mkdir -p /data && chown node:node /data
USER node
ENV CACHE_FILE=/data/cache.json
EXPOSE 3000
CMD ["node", "server.js"]
