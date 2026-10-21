#!/bin/sh
# re-provision the sandbox after a restart (packages live outside /workspace)
cd /workspace/work/promo
pip install -q playwright numpy scipy soundfile soxr pyloudnorm pillow fonttools brotli librosa scikit-learn matplotlib 2>&1 | tail -1
python3 -m playwright install --with-deps chromium 2>&1 | tail -1
pip install -q --no-deps -e repos/Leonxlnx_earshot 2>&1 | tail -1
(python3 -m http.server 8765 --directory app >/tmp/http.log 2>&1 &)
(python3 -m http.server 8766 --directory film >/tmp/http2.log 2>&1 &)
sleep 1
curl -s -o /dev/null -w "app %{http_code}\n" http://localhost:8765/index.html
curl -s -o /dev/null -w "film %{http_code}\n" http://localhost:8766/comp.html
