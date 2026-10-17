#!/usr/bin/with-contenv bashio
# Home Assistant supplies /data/options.json; projects and floorplans live in /data
# (and are therefore part of every Home Assistant backup).
export OPTIONS_FILE="/data/options.json"
export DATA_DIR="/data"

bashio::log.info "Starting Waterzijdig Inregelen on :8099 (ingress)"

cd /app || exit 1
exec python3 -m uvicorn app.main:app \
    --host 0.0.0.0 \
    --port 8099 \
    --proxy-headers \
    --forwarded-allow-ips '*' \
    --log-level "$(bashio::config 'log_level')"
