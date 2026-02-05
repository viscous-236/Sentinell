FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/
COPY tsconfig.json ./

# Expose the port your app listens on
EXPOSE 3000

RUN npm run build

CMD ["npm", "start"]
