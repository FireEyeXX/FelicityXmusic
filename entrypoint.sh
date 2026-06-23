#!/bin/sh

# BLAS/numba threading — let each analysis thread use multiple cores.
# Host has 16 cores; defaults are env-overridable. Higher default than before.
: "${OPENBLAS_NUM_THREADS:=4}"; export OPENBLAS_NUM_THREADS
: "${MKL_NUM_THREADS:=4}"; export MKL_NUM_THREADS
: "${NUMBA_NUM_THREADS:=4}"; export NUMBA_NUM_THREADS

# Auto-bump cache version on every container start
CACHE_BUST=$(date +%s)

# Replace placeholders in HTML (CSS links, favicon, main script tag)
sed -i "s/__CACHE_BUST__/${CACHE_BUST}/g" /app/static/index.html

# Add cache bust to all JS module imports (from './foo.js' → from './foo.js?v=...')
for f in /app/static/js/*.js; do
  sed -i "s/\.js'/\.js?v=${CACHE_BUST}'/g" "$f"
done

# Self-update yt-dlp to the latest NIGHTLY on every start (YouTube breaks the
# downloader between releases). Bounded + non-fatal: if the network/PyPI is down
# we keep the nightly baked into the image. Skip with YTDLP_NO_UPDATE=1.
if [ "${YTDLP_NO_UPDATE:-0}" != "1" ]; then
  echo "Updating yt-dlp (nightly)..."
  timeout 120 pip install -U --pre --quiet "yt-dlp[default]" \
    && echo "yt-dlp: $(yt-dlp --version 2>/dev/null)" \
    || echo "yt-dlp update skipped (using image version $(yt-dlp --version 2>/dev/null))"
fi

if [ -f /app/certs/cert.pem ] && [ -f /app/certs/key.pem ]; then
  echo "Starting with HTTPS..."
  exec uvicorn main:app --host 0.0.0.0 --port 8090 --ssl-keyfile /app/certs/key.pem --ssl-certfile /app/certs/cert.pem
else
  echo "Starting with HTTP (no certs found)..."
  exec uvicorn main:app --host 0.0.0.0 --port 8090
fi
