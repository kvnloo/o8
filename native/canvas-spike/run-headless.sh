#!/usr/bin/env bash
# Run the scripted canvas spike on an owned headless Sway and capture frames.
# usage: run-headless.sh BINARY OUTDIR
set -euo pipefail
bin=$(readlink -f "$1"); out=$(mkdir -p "$2" && cd "$2" && pwd)
root=$HOME/.local/opt/cua-sway/root
rt=$(mktemp -d "${TMPDIR:-/tmp}/canvas-spike-rt.XXXX"); chmod 700 "$rt"
cat >"$rt/sway.cfg" <<'EOF'
output HEADLESS-1 mode 1400x900 scale 1
default_border none
xwayland disable
EOF
cleanup() { kill "${app:-}" "${sw:-}" 2>/dev/null || true; wait 2>/dev/null || true; rm -rf "$rt"; }
trap cleanup EXIT INT TERM
env -i HOME="$HOME" PATH="$root/usr/bin:/usr/bin" XDG_RUNTIME_DIR="$rt" LD_LIBRARY_PATH="$root/usr/lib" \
  WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 WLR_LIBINPUT_NO_DEVICES=1 \
  "$root/usr/bin/sway" -c "$rt/sway.cfg" >"$out/sway.log" 2>&1 & sw=$!
for _ in $(seq 50); do sock=$(ls "$rt" | grep -m1 '^wayland-[0-9]*$' || true); [ -n "$sock" ] && break; sleep 0.1; done
[ -n "${sock:-}" ] || { echo "sway did not start"; tail "$out/sway.log"; exit 1; }
export XDG_RUNTIME_DIR="$rt" WAYLAND_DISPLAY="$sock"; unset DISPLAY HYPRLAND_INSTANCE_SIGNATURE SWAYSOCK
CANVAS_SPIKE_SCRIPT=1 "$bin" >"$out/app.log" 2>&1 & app=$!
# Capture when the app announces each state.
seen=""
while kill -0 "$app" 2>/dev/null; do
  for shot in $(grep -o 'SHOT [a-z]*' "$out/app.log" | cut -d' ' -f2); do
    case " $seen " in *" $shot "*) ;; *) grim "$out/$shot.png" && seen="$seen $shot";; esac
  done
  sleep 0.1
done
wait "$app" || echo "app exit $?"
cat "$out/app.log"
ls -la "$out"
