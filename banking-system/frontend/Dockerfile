FROM node:18-alpine AS build
WORKDIR /app
COPY package*.json ./
# npm install (not ci): the committed lockfile is not fully in sync with package.json.
RUN npm install --no-audit --no-fund
ARG REACT_APP_API_URL
ENV REACT_APP_API_URL=${REACT_APP_API_URL} \
    # Keep every script in a file so the nginx Content-Security-Policy can forbid inline scripts.
    INLINE_RUNTIME_CHUNK=false \
    GENERATE_SOURCEMAP=false
COPY . ./
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /app/build /usr/share/nginx/html
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
