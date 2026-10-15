#!/usr/bin/env bash
# B-roll + soundtrack for the "Intelligence is collaborative" cut (Collab.tsx).
# Pulls the YouTube sources, then cuts each shot to a 1080x1080, 30 fps clip in public/broll/cuts.
# Everything it writes is git-ignored (third-party footage): never commit it.
#   ./broll.sh
set -euo pipefail
cd "$(dirname "$0")/public"
mkdir -p broll/cuts music

YT=(yt-dlp --cookies-from-browser chrome -q --no-warnings)
get() { [ -f "broll/$1.mp4" ] || "${YT[@]}" -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b" --merge-output-format mp4 -o "broll/$1.%(ext)s" "https://youtu.be/$1"; }

[ -f music/soundtrack.mp3 ] || "${YT[@]}" -x --audio-format mp3 --audio-quality 0 -o "music/soundtrack.%(ext)s" "https://youtu.be/ck6MUSns63o"

get aygSMgK3BEM   # The Thinking Machine (1961): Oliver Selfridge
get A1Xa_FCsDNk   # neurons growing, two-photon fly-through
get Cdx-hxqCGqY   # Argentina v Serbia 2006, Cambiasso's 26-pass goal
get h65f8CR7AmA   # BET Cypher 2013, Kendrick Lamar
get S3wsCRJVUyg   # SpongeBob time card, "A few moments later"
get djm4h7nv2oI   # Phineas and Ferb, "I know what we're gonna do today"
get MtKSbYJFxMc   # Cars, ka-chow compilation

BW="hue=s=0,eq=contrast=1.25:brightness=-0.02"
# cut <name> <source id> <start s> <duration s> <speed> <extra filters> [crop x offset 0..1]
cut() {
  local name=$1 id=$2 ss=$3 t=$4 speed=$5 vf=$6 cx=${7:-0.5}
  local crop="crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))*$cx':0,scale=1080:1080:flags=lanczos,setsar=1"
  ffmpeg -v error -y -ss "$ss" -t "$t" -i "broll/$id.mp4" \
    -vf "setpts=PTS/$speed,$crop,fps=30${vf:+,$vf}" \
    -af "atempo=$speed" -c:v libx264 -crf 16 -preset fast -c:a aac -b:a 192k "broll/cuts/$name.mp4"
  echo "cut $name"
}

cut selfridge  aygSMgK3BEM 108.95 3.2  1   "crop=1080:1050:0:30,scale=1080:1080,$BW"
cut neurons    A1Xa_FCsDNk 11.6   1.5  1   "$BW"
cut ball-a     Cdx-hxqCGqY 44.0   2.1  3   "eq=saturation=0.55:contrast=1.15"
cut ball-b     Cdx-hxqCGqY 61.0   1.4  2   "eq=saturation=0.55:contrast=1.15"
cut ball-c     Cdx-hxqCGqY 63.85  1.6  1.3 "eq=saturation=0.55:contrast=1.15"
cut cypher     h65f8CR7AmA 30.0   1.5  1   "crop=800:800:170:30,scale=1080:1080,$BW" 0.5
cut phineas    djm4h7nv2oI 0.85   1.8  1   "crop=880:880:200:60,scale=1080:1080" 0.62
cut kachow     MtKSbYJFxMc 1.08   0.95 1   "crop=760:760:160:150,scale=1080:1080" 0.5

# the time card keeps its full width: fitted over a blurred, enlarged copy of itself
ffmpeg -v error -y -t 1.9 -i broll/S3wsCRJVUyg.mp4 -filter_complex \
  "[0:v]split[a][b];[a]scale=-2:1080,crop=1080:1080,gblur=sigma=30,eq=brightness=-0.15[bg];[b]scale=1080:-2[fg];[bg][fg]overlay=0:(H-h)/2,setsar=1,fps=30" \
  -c:v libx264 -crf 16 -preset fast -c:a aac -b:a 192k broll/cuts/later.mp4
echo "cut later"
