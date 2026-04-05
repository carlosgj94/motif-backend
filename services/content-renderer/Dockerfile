FROM mcr.microsoft.com/playwright:v1.59.1-noble

ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CONTENT_RENDERER_BIND_ADDR=0.0.0.0
ENV CONTENT_RENDERER_PORT=8788

WORKDIR /app

COPY services/content-renderer/package.json ./
RUN npm install --omit=dev

COPY services/content-renderer/src ./src

EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["npm", "start"]
