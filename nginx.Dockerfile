FROM nginx:alpine
ARG NGINX_CONF=nginx.local.conf
COPY ${NGINX_CONF} /etc/nginx/nginx.conf
