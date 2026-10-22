#!/bin/sh
# Lets the JG-RND firmware flasher open the RND in DFU (BOOT) mode without root:
# STMicroelectronics DFU bootloader, 0483:df11.
cat > /etc/udev/rules.d/50-jg-rnd-dfu.rules <<'RULES'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="df11", MODE="0666"
RULES
udevadm control --reload-rules >/dev/null 2>&1 || true
udevadm trigger >/dev/null 2>&1 || true
