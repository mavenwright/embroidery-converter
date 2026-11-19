# syntax=docker/dockerfile:1
# The static output is architecture-independent, so build it once on the
# builder's own platform and only the nginx stage is per-arch.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY app ./app
COPY src ./src
COPY public ./public
RUN npm run build

FROM nginx:1.27-alpine
LABEL org.opencontainers.image.title="Embroidery File Converter" \
      org.opencontainers.image.description="Browser-only viewer and converter for PES, DST, JEF, EXP and VP3 embroidery files. Files never leave the device." \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/mavenwright/embroidery-converter" \
      org.opencontainers.image.url="https://mavenwright.com/en/stitchkit/tools/embroidery-file-converter"

COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/security-headers.conf /etc/nginx/security-headers.conf
RUN rm -f /etc/nginx/conf.d/default.conf
COPY docker/40-config.sh /docker-entrypoint.d/40-config.sh
# The licence and third-party notices travel with the image, outside the web root so nginx does not serve them.
COPY LICENSE NOTICE /usr/share/doc/embroidery-converter/
COPY --from=build --chown=nginx:nginx /src/dist /usr/share/nginx/html
# config.json is (re)written at start by 40-config.sh as the nginx user.
RUN chmod +x /docker-entrypoint.d/40-config.sh \
 && chown nginx:nginx /usr/share/nginx/html

USER nginx
ENV SHOW_CREDIT=true
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
