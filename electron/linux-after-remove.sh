#!/bin/sh
rm -f /etc/udev/rules.d/50-jg-rnd-dfu.rules
udevadm control --reload-rules >/dev/null 2>&1 || true
