# Mesh Mender has no build step — the browser runs the source as written, and
# three.js and fflate are vendored into the repo. So this is a plain nginx image
# with the static files copied in, and it builds in seconds.
FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

WORKDIR /usr/share/nginx/html
RUN rm -rf ./*

# Copied explicitly rather than with a wildcard, so tests, docs and local
# scripts never end up on the server by accident.
COPY index.html ./
COPY css/    ./css/
COPY js/     ./js/
COPY vendor/ ./vendor/

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/health || exit 1
