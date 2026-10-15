#!/usr/bin/env bash
# Archive B-roll, voices and instrumental for the "Intelligence is collaborative" cut (Collab.tsx).
# Pulls the YouTube sources, cuts each shot to a 1080x1080, 30 fps, black-and-white clip in
# public/broll/cuts and each voice line to a loudness-matched wav in public/broll/vo.
# Everything it writes is git-ignored (third-party footage and music): never commit it.
#   ./broll.sh
set -euo pipefail
cd "$(dirname "$0")/public"
mkdir -p broll/cuts broll/vo music

YT=(yt-dlp --cookies-from-browser chrome -q --no-warnings)
get() { [ -f "broll/$1.mp4" ] || "${YT[@]}" -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b" --merge-output-format mp4 -o "broll/$1.%(ext)s" "https://youtu.be/$1"; }

# "Wild", Kanye West type beat by Encore: 95.7 BPM, drop at 20.50 s
[ -f music/instrumental.mp3 ] || "${YT[@]}" -x --audio-format mp3 --audio-quality 0 -o "music/instrumental.%(ext)s" "https://youtu.be/dEwR9MabFr8"

get aygSMgK3BEM   # The Thinking Machine (1961): Selfridge, Wiesner, Shannon
get _9_AEVQ_p74   # Claude Shannon demonstrates Theseus, Bell Labs (1952)
get IOHayh06LJ4   # Hubel and Wiesel, cat visual cortex
get bCoe7fLROlg   # The Human Brain, Encyclopaedia Britannica Films (1955)
get vfl3M-_5xUk   # The Human Body: The Brain, Coronet (1968)
get 2BzRjfOoiVQ   # Bell switchboard operators (1940s)
get A1Xa_FCsDNk   # neurons growing, two-photon fly-through

BW="hue=s=0,eq=contrast=1.22:brightness=-0.02"
# shot <name> <source id> <start s> <duration s> [filters before the square crop]
shot() {
  local name=$1 id=$2 ss=$3 t=$4 pre=${5:-}
  ffmpeg -v error -y -ss "$ss" -t "$t" -i "broll/$id.mp4" -an \
    -vf "${pre:+$pre,}crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080:flags=lanczos,setsar=1,fps=30,$BW" \
    -c:v libx264 -crf 16 -preset fast "broll/cuts/$name.mp4"
  echo "shot $name"
}
# vo <name> <source id> <start s> <end s>: voice line, loudness matched, with tiny fades
vo() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "broll/$2.mp4" -vn -ac 2 -ar 48000 \
    -af "highpass=f=90,loudnorm=I=-16:TP=-2,afade=t=in:d=0.02,areverse,afade=t=in:d=0.06,areverse" "broll/vo/$1.wav"
  echo "vo $1"
}

shot selfridge  aygSMgK3BEM 108.95 3.3 "crop=iw:ih-24:0:24"
shot checkers   aygSMgK3BEM 54.0   1.6
shot tapes      aygSMgK3BEM 142.5  1.6
shot wiesner    aygSMgK3BEM 30.6   2.0
shot shannon    _9_AEVQ_p74 401.0  2.6 "crop=iw*0.75:ih:0:0"
shot maze       _9_AEVQ_p74 394.0  2.7
shot cat        IOHayh06LJ4 5.8    1.5
shot dot        IOHayh06LJ4 54.8   2.2
shot diagram    bCoe7fLROlg 180.0  5.2
shot neurons    A1Xa_FCsDNk 11.0   2.0
shot operators  2BzRjfOoiVQ 12.0   1.4
shot plugs      2BzRjfOoiVQ 27.3   2.0

vo selfridge  aygSMgK3BEM 108.95 112.20
vo wiesner    aygSMgK3BEM 34.10  37.95
vo hello      _9_AEVQ_p74 7.90   10.40
vo learn      _9_AEVQ_p74 25.40  27.20
vo response   IOHayh06LJ4 56.60  58.80
vo organism   bCoe7fLROlg 475.60 479.95
vo maze       _9_AEVQ_p74 110.75 113.30
vo billions   vfl3M-_5xUk 917.90 919.85
vo emerge     aygSMgK3BEM 116.55 118.25
