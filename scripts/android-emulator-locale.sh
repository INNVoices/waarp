#!/usr/bin/env bash
# The existing UI journeys and gallery assert Russian labels on disposable AVDs.
set -euo pipefail
adb=(adb -s emulator-5554)
[[ "$("${adb[@]}" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
if [[ $("${adb[@]}" shell getprop ro.build.version.sdk | tr -d '\r') -ge 33 ]]; then
  package=local.waarp.android.debug
  "${adb[@]}" shell cmd locale set-app-locales "$package" --user 0 --locales ru-RU
  "${adb[@]}" shell cmd locale get-app-locales "$package" --user 0 | grep -F ru-RU
else
  # The API 29 preparation restarts the framework after writing system_locales.
  "${adb[@]}" shell am get-config | grep -E '^config: (.*-)?ru-rRU[-,]'
fi
