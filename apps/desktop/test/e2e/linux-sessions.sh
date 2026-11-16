#!/usr/bin/env bash
# Runs test/e2e/linux-computer-use.mjs in a throwaway desktop session of each kind: X11 (Xvfb
# and Mutter as its compositor, as GNOME on Xorg) and GNOME on Wayland (gnome-shell --headless).
#   test/e2e/linux-sessions.sh <Brigade executable> <agent-desktop binary> [x11|wayland]...
# Needs Ubuntu 24.04's xvfb, mutter, gnome-shell, at-spi2-core, xdotool, imagemagick, pipewire,
# wireplumber, xdg-desktop-portal-gnome, gnome-calculator and gnome-text-editor. On Wayland the
# person's Allow for screenshots is given up front, in the portal's permission store: a headless
# session can't click the dialog.
set -uo pipefail
cd "$(dirname "$0")/../.."
APP=$(realpath "$1")
AD=$(realpath "$2")
shift 2
KINDS=${*:-x11 wayland}
STATUS=0

# A session in a process group of its own, its output through a file: the services the bus
# starts outlive it otherwise, and keep the caller's output open. Everything of it goes at the end.
session() {
  local log="$RUN/session.log"
  setsid "$@" >"$log" 2>&1 &
  local leader=$!
  # At most 4 minutes: its log is shown either way.
  ( sleep 240; echo "session timed out" >>"$log"; kill -TERM -- "-$leader" ) 2>/dev/null &
  local watchdog=$!
  wait "$leader"
  local code=$?
  kill "$watchdog" 2>/dev/null
  kill -TERM -- "-$leader" 2>/dev/null
  sleep 1
  kill -KILL -- "-$leader" 2>/dev/null
  grep -v -e 'dbus-daemon\[' -e 'WARNING' -e '^$' "$log"
  return $code
}

for KIND in $KINDS; do
  echo "=== $KIND"
  RUN=$(mktemp -d)
  export XDG_RUNTIME_DIR=$RUN/runtime HOME=$RUN/home
  mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$HOME"
  if [ "$KIND" = x11 ]; then
    Xvfb :58 -screen 0 1280x800x24 >/dev/null 2>&1 &
    SERVER=$!
    sleep 1
    session env -u WAYLAND_DISPLAY DISPLAY=:58 XDG_SESSION_TYPE=x11 dbus-run-session -- bash -c "
      dbus-update-activation-environment DISPLAY XDG_RUNTIME_DIR XDG_SESSION_TYPE >/dev/null 2>&1
      /usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
      mutter --x11 --replace >\$HOME/mutter.log 2>&1 &
      sleep 3
      node test/e2e/linux-computer-use.mjs '$APP' '$AD'
    " || STATUS=1
    kill $SERVER 2>/dev/null
  else
    session env -u DISPLAY XDG_SESSION_TYPE=wayland XDG_CURRENT_DESKTOP=GNOME dbus-run-session -- bash -c "
      dbus-update-activation-environment XDG_RUNTIME_DIR XDG_SESSION_TYPE XDG_CURRENT_DESKTOP WAYLAND_DISPLAY=wayland-0 >/dev/null 2>&1
      pipewire >/dev/null 2>&1 &
      sleep 0.5
      wireplumber >/dev/null 2>&1 &
      timeout 10 gdbus call --session --dest org.freedesktop.impl.portal.PermissionStore \\
        --object-path /org/freedesktop/impl/portal/PermissionStore \\
        --method org.freedesktop.impl.portal.PermissionStore.SetPermission screenshot true screenshot '' \"['yes']\" >/dev/null
      touch \$HOME/started
      echo starting gnome-shell
      gnome-shell --headless --wayland --virtual-monitor 1280x800 >\$HOME/gnome-shell.log 2>&1 &
      for i in \$(seq 1 40); do [ -S \$XDG_RUNTIME_DIR/wayland-0 ] && break; sleep 0.5; done
      # Its Xwayland's display (the X socket it made as it started) once it answers: Electron
      # doesn't start with a DISPLAY it can't reach.
      export WAYLAND_DISPLAY=wayland-0
      for i in \$(seq 1 40); do
        export XAUTHORITY=\$(ls \$XDG_RUNTIME_DIR/.mutter-Xwaylandauth.* 2>/dev/null | head -1)
        for X in \$(find /tmp/.X11-unix -newer \$HOME/started -name 'X*' | sort); do
          export DISPLAY=:\${X##*/X}
          timeout 2 xdotool getdisplaygeometry >/dev/null 2>&1 && break 2
        done
        sleep 0.5
      done
      sleep 2
      echo \"session: DISPLAY=\$DISPLAY XAUTHORITY=\$XAUTHORITY\"
      node test/e2e/linux-computer-use.mjs '$APP' '$AD'
    " || STATUS=1
  fi
  rm -rf "$RUN" 2>/dev/null
done
exit $STATUS
