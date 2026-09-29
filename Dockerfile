FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
ENV NOVTF_DATA_DIR=/var/lib/novtf
CMD ["node", "--experimental-strip-types", "src/main.ts"]
