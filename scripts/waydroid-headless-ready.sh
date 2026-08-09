#!/bin/bash

set -euo pipefail

LXC_PATH=${WAYDROID_LXC_PATH:-/var/lib/waydroid/lxc}
ADB_PORT=${WAYDROID_ADB_PORT:-5555}

android() {
  lxc-attach -P "$LXC_PATH" -n waydroid -- "$@"
}

for _ in $(seq 1 150); do
  if [[ "$(android /system/bin/getprop sys.boot_completed 2>/dev/null || true)" == "1" ]]; then
    break
  fi
  sleep 2
done

if [[ "$(android /system/bin/getprop sys.boot_completed 2>/dev/null || true)" != "1" ]]; then
  echo "Waydroid did not finish booting within 300 seconds" >&2
  exit 1
fi

android_cidr=$(android /system/bin/ip -4 -o addr show eth0 | awk '{print $4; exit}')
android_ip=${android_cidr%/*}
android_network=$(android /system/bin/ip -4 route show dev eth0 scope link | awk '{print $1; exit}')
gateway=$(ip -4 -o addr show waydroid0 | awk '{split($4, address, "/"); print address[1]; exit}')
route_table=$(android /system/bin/awk '$2 == "eth0" { print $1; exit }' /data/misc/net/rt_tables)

if [[ -z "$android_ip" || -z "$android_network" || -z "$gateway" || -z "$route_table" ]]; then
  echo "Could not determine Waydroid network routing values" >&2
  exit 1
fi

# Some Android 11 MAINLINE images advertise routes through ConnectivityService
# but leave the per-interface policy table empty on this STB kernel.
android /system/bin/ip route replace "$android_network" dev eth0 src "$android_ip" table "$route_table"
android /system/bin/ip route replace default via "$gateway" dev eth0 table "$route_table"

adb connect "$android_ip:$ADB_PORT" >/dev/null
adb -s "$android_ip:$ADB_PORT" shell wm dismiss-keyguard >/dev/null
adb -s "$android_ip:$ADB_PORT" shell svc power stayon true >/dev/null

if [[ "$(adb -s "$android_ip:$ADB_PORT" get-state)" != "device" ]]; then
  echo "Waydroid ADB is not authorized and ready" >&2
  exit 1
fi

echo "Waydroid headless runtime ready at $android_ip:$ADB_PORT"

