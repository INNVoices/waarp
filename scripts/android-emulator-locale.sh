#!/usr/bin/env bash
# The existing UI journeys and gallery assert Russian labels on disposable AVDs.
set -euo pipefail
adb=(adb -s emulator-5554)
[[ "$("${adb[@]}" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
# Android reads system_locales into the foreground user's Configuration at boot.
"${adb[@]}" shell settings --user 0 put system system_locales ru-RU
"${adb[@]}" reboot
timeout 120 "${adb[@]}" wait-for-device
for attempt in {1..90}; do
  if [[ $("${adb[@]}" shell getprop sys.boot_completed | tr -d '\r') == 1 ]]; then
    config=$("${adb[@]}" shell am get-config)
    if grep -Eq '^config: (.*-)?ru-rRU[-,]' <<< "$config"; then
      "${adb[@]}" shell wm dismiss-keyguard
      exit 0
    fi
  fi
  sleep 1
done
echo "The emulator did not boot with the Russian fixture locale: ${config:-unknown}" >&2
exit 1
