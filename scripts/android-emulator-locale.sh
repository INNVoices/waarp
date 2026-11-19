#!/usr/bin/env bash
# The existing UI journeys and gallery assert Russian labels on disposable AVDs.
set -euo pipefail
adb=(adb -s emulator-5554)
[[ "$("${adb[@]}" shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]]
"${adb[@]}" shell am broadcast --user 0 --include-stopped-packages \
  -a com.android.intent.action.SET_LOCALE \
  -n com.android.customlocale2/.CustomLocaleReceiver \
  --es com.android.intent.extra.LOCALE ru_RU
for attempt in {1..20}; do
  config=$("${adb[@]}" shell am get-config)
  if grep -Eq 'config: [^ ]*(^|[-, ])ru(-rRU)?[-,]' <<< "$config"; then exit 0; fi
  if grep -Eq '^config: ru(-rRU)?[-,]' <<< "$config"; then exit 0; fi
  sleep 1
done
echo "The emulator did not select the Russian fixture locale: $config" >&2
exit 1
