FROM node:20-alpine

WORKDIR /usr/src/app

ARG CACHE_BUST=1
RUN echo "Build version: $CACHE_BUST"

COPY package*.json ./

RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production

EXPOSE 3000

CMD ["npm", "run", "start:api"]
