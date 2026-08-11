@echo off
cd /d C:\Users\David\karma-leads-nocodb
echo Starting Karma Leads ...
echo   team app + API  : http://localhost:8080/app
echo   NocoDB admin    : http://localhost:8082/dashboard   (container, admins only)
echo   postgres        : docker compose up -d
docker compose up -d
node server\index.js
