#!/usr/bin/env bash
# Footage, voices and instrumental for the "Unleash intelligence" cut (Collab.tsx).
# Pulls the YouTube sources, cuts each shot to a 1080x1080, 30 fps clip in public/broll/cuts and each
# voice line to a loudness-matched wav in public/broll/vo.
# Everything it writes is git-ignored (third-party footage and music): never commit it.
#   ./broll.sh
set -euo pipefail
cd "$(dirname "$0")/public"
mkdir -p broll/cuts broll/vo music

YT=(yt-dlp --cookies-from-browser chrome -q --no-warnings)
FMT="bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b"
get() { [ -f "broll/$1.mp4" ] || "${YT[@]}" -f "$FMT" --merge-output-format mp4 -o "broll/$1.%(ext)s" -- "$1"; }
# part <name> <id> <section>: only a section of a long video
part() { [ -f "broll/$1.mp4" ] || "${YT[@]}" --download-sections "*$3" -f "$FMT" --merge-output-format mp4 -o "broll/$1.%(ext)s" -- "$2"; }

# "Wild", Kanye West type beat by Encore: 95.7 BPM, builds from 0 s, drops at 20.40 s
[ -f music/instrumental.mp3 ] || "${YT[@]}" -x --audio-format mp3 --audio-quality 0 -o "music/instrumental.%(ext)s" -- dEwR9MabFr8

get aygSMgK3BEM   # The Thinking Machine (1961): Selfridge, Wiesner, Shannon
get _9_AEVQ_p74   # Claude Shannon demonstrates Theseus, Bell Labs (1952)
get IOHayh06LJ4   # Hubel and Wiesel, cat visual cortex
get bCoe7fLROlg   # The Human Brain, Encyclopaedia Britannica Films (1955)
get 2BzRjfOoiVQ   # Bell switchboard operators (1940s)
get A1Xa_FCsDNk   # neurons growing, two-photon fly-through
get 2B-XwPjn9YY   # Steve Jobs introduces the Macintosh (1984)
get 2hXSfS1i4jU   # Steve Jobs, "a bicycle for our minds" (1990)
get kFlqbFORpFA   # circuit board macro
get U_OexTUIyik   # microchip macro
get WVLGKq9An28   # Intel fab cleanroom
get Jk-xqPKOxl4   # Foxconn iPhone line, ABC News (2012)
get 3JQ3hYko51Y   # neural network 3D simulation
get 8tq1C8spV_g   # AlphaGo (2016) trailer
get gg7WjuFs8F4   # AlphaFold: the making of a scientific breakthrough
get BWCCPy7Rg-s   # BBC News on ChatGPT (2022)
part U9mJuUkhUzk U9mJuUkhUzk 0:00-4:00     # OpenAI DevDay keynote (2023)
part nobel       6-A4dUowT4Q 27:20-31:00   # Nobel Prize ceremony 2024, chemistry

# grades move with the era: archive in black and white, the 80s faded, today in colour
BW="hue=s=0,eq=contrast=1.22:brightness=-0.02"
OLD="eq=saturation=0.5:contrast=1.1,colorbalance=rs=0.06:bs=-0.06"
NOW="eq=saturation=0.85:contrast=1.08"
# shot <name> <source> <start s> <duration s> <grade> [filters before the square crop]
shot() {
  local name=$1 id=$2 ss=$3 t=$4 grade=$5 pre=${6:-}
  ffmpeg -v error -y -ss "$ss" -t "$t" -i "broll/$id.mp4" -an \
    -vf "${pre:+$pre,}crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080:flags=lanczos,setsar=1,fps=30,$grade,format=yuv420p" \
    -c:v libx264 -crf 16 -preset fast "broll/cuts/$name.mp4"
  echo "shot $name"
}
# vo <name> <source> <start s> <end s>: voice line, loudness matched, with tiny fades
vo() {
  ffmpeg -v error -y -ss "$3" -to "$4" -i "broll/$2.mp4" -vn -ac 2 -ar 48000 \
    -af "highpass=f=90,loudnorm=I=-16:TP=-2,afade=t=in:d=0.02,areverse,afade=t=in:d=0.08,areverse" "broll/vo/$1.wav"
  echo "vo $1"
}

# the 50s and 60s
shot selfridge  aygSMgK3BEM 108.95 3.7 "$BW" "crop=iw:ih-24:0:24"
shot checkers   aygSMgK3BEM 54.0   1.6 "$BW"
shot tapes      aygSMgK3BEM 142.5  1.6 "$BW"
shot wiesner    aygSMgK3BEM 30.6   2.0 "$BW"
shot shannon    _9_AEVQ_p74 401.0  2.6 "$BW" "crop=iw*0.75:ih:0:0"
shot maze       _9_AEVQ_p74 394.0  1.0 "$BW"
shot diagram    bCoe7fLROlg 180.0  3.4 "$BW"
shot dot        IOHayh06LJ4 54.8   1.8 "$BW"
shot plugs      2BzRjfOoiVQ 27.3   2.0 "$BW"
shot neurons    A1Xa_FCsDNk 11.0   2.0 "$BW"
# the 80s and 90s
shot mac        2B-XwPjn9YY 66.0   1.6 "$OLD"
shot jobs       2hXSfS1i4jU 49.0   2.2 "$OLD"
shot great      2B-XwPjn9YY 126.0  1.4 "$OLD"
# the build: silicon and factories
shot board      kFlqbFORpFA 2.0    1.2 "$NOW"
shot wafer      WVLGKq9An28 0.3    0.8 "$NOW"
shot cleanroom  WVLGKq9An28 6.4    0.6 "$NOW"
shot chips      U_OexTUIyik 3.0    0.6 "$NOW"
shot fab        WVLGKq9An28 28.6   0.6 "$NOW"
shot foxconn    Jk-xqPKOxl4 27.0   0.6 "$NOW" "crop=iw:ih*0.8:0:0"
shot line       Jk-xqPKOxl4 61.0   0.5 "$NOW" "crop=iw*0.8:ih*0.7:iw*0.2:0"
# now
shot nn         3JQ3hYko51Y 20.0   1.4 "$NOW"
shot alphago    8tq1C8spV_g 1.0    1.4 "$NOW"
shot alphafold  gg7WjuFs8F4 341.0  2.8 "$NOW"
shot chatgpt    BWCCPy7Rg-s 2.0    1.4 "$NOW" "crop=iw*0.75:ih:iw*0.25:0"
shot devday     U9mJuUkhUzk 20.5   1.4 "$NOW"
shot nobel      nobel       165.0  2.0 "$NOW" "crop=iw*0.66:ih*0.9:iw*0.04:0"

vo selfridge     aygSMgK3BEM 108.95 112.20
vo wiesner       aygSMgK3BEM 34.10  37.95
vo organism      bCoe7fLROlg 475.60 479.95
vo bicycle       2hXSfS1i4jU 55.90  58.50
vo breakthrough  nobel       4.05   8.15
vo emerge        aygSMgK3BEM 116.55 118.25
