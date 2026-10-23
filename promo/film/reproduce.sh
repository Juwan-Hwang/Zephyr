#!/bin/sh
# Rebuild deliver/Zephyr-promo-v3.mp4 from this branch.
#   sh reproduce.sh            → render from the committed footage + committed 3D frames (exact v3 inputs)
#   RECAPTURE=1 sh reproduce.sh → also re-record the app and re-render the 3D shots first
set -e
cd "$(dirname "$0")"
pip install -q -r requirements.txt
python3 -m playwright install --with-deps chromium
[ -d repos/Leonxlnx_earshot ] || { git clone -q https://github.com/Leonxlnx/earshot repos/Leonxlnx_earshot; git -C repos/Leonxlnx_earshot checkout -q 925ebe56a1b755e5d354ab642bb8f344440cfa9c; }
pip install -q --no-deps -e repos/Leonxlnx_earshot
# app/ = the front-end snapshot recorded (Zephyr UI + Argon v9 logo + demo mock incl. patches/demo-mock-api.patch);
# refreshed 2026-10-23 from main 135143e (v2.5.0 UI) with tokens + UnoCSS regenerated via the repo's build:css steps
(python3 -m http.server 8765 --directory app >/tmp/http-app.log 2>&1 &)
(python3 -m http.server 8766 --directory film >/tmp/http-film.log 2>&1 &)
sleep 1
if [ "${RECAPTURE:-0}" = 1 ]; then
  python3 capture2.py console lang minimal proxies prism theme close
  python3 r3d_seq.py open 5.85 film/frames/open --sub 3
  python3 r3d_seq.py end 6.6 film/frames/end --sub 3
fi
python3 render_film.py --comp comp2.html --out film/out2/frames --workers 3
(cd film && python3 music2.py && python3 sound2.py)
ffmpeg -y -v error -framerate 30 -i film/out2/frames/%05d.jpg -i film/audio/mix2.wav \
  -c:v libx264 -preset fast -crf 16 -pix_fmt yuv420p -profile:v high -tune film \
  -c:a aac -b:a 256k -af "loudnorm=I=-14:TP=-1:LRA=9" -shortest -movflags +faststart deliver/Zephyr-promo-v3.rebuild.mp4
echo "done → deliver/Zephyr-promo-v3.rebuild.mp4"

# English cut:
#   python3 render_film.py --comp comp2-en.html --out film/out2-en/frames --workers 3
#   (cd film && python3 sound2-en.py)   # writes audio/mix2-en.wav
#   ffmpeg ... -i film/audio/mix2-en.wav ... deliver/Zephyr-promo-v3-en.mp4  (same flags as above)
