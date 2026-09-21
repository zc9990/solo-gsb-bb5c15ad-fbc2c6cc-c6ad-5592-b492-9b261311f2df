# ---------- 构建前端 ----------
FROM node:20-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install
COPY client/ ./
RUN npm run build

# ---------- 运行镜像 ----------
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm install --omit=dev
COPY server/ ./server/
COPY --from=client-build /app/client/dist ./client/dist
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
