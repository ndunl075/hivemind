#!/bin/sh
# Renders all frames in 4 parallel segments, then joins them.
set -e
cd "$(dirname "$0")"
N=2940; W=4; S=$(( (N + W - 1) / W ))
for i in 0 1 2 3; do
  node render.cjs segment $((i*S)) $(( (i+1)*S < N ? (i+1)*S : N )) out/seg$i.mkv &
done
wait
printf "file 'seg0.mkv'\nfile 'seg1.mkv'\nfile 'seg2.mkv'\nfile 'seg3.mkv'\n" > out/segs.txt
ffmpeg -y -loglevel error -f concat -safe 0 -i out/segs.txt -c copy out/picture.mkv
