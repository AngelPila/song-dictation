FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html landing.css landing.js app.html styles.css app.js ui.css /usr/share/nginx/html/
COPY assets/*.jpg /usr/share/nginx/html/assets/
