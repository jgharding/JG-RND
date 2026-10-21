// @ts-nocheck
import { dfu } from './dfu.js';
import { dfuse } from './dfuse.js';
import { applyJgPatch, type JgPatchFile } from './jgPatch';
import {
  FIRMWARE_PERMISSION_SWITCH,
  LATEST_FIRMWARE_FILE,
  LATEST_FIRMWARE_PATCH_FILE,
  LATEST_FIRMWARE_STRING
} from '../types';

export interface FlasherState {
  status: 'idle' | 'ready' | 'connecting' | 'connected' | 'erasing' | 'flashing' | 'manifesting' | 'complete' | 'error';
  stepText: string;
  eraseProgress: number; // 0 - 100
  flashProgress: number; // 0 - 100
  bytesSent: number;
  totalBytes: number;
  error: string | null;
  targetInterfaceName: string | null;
  log: string[];
}

type FlasherListener = (state: FlasherState) => void;

class FlasherService {
  private state: FlasherState = {
    status: 'idle',
    stepText: 'Ready to connect',
    eraseProgress: 0,
    flashProgress: 0,
    bytesSent: 0,
    totalBytes: 0,
    error: null,
    targetInterfaceName: null,
    log: []
  };

  private listeners: Set<FlasherListener> = new Set();
  private dfuseDevice: any = null;

  public subscribe(listener: FlasherListener): () => void {
    this.listeners.add(listener);
    listener({ ...this.state });
    return () => this.listeners.delete(listener);
  }

  private updateState(partial: Partial<FlasherState>) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) {
      listener({ ...this.state });
    }
  }

  private addLog(msg: string) {
    this.state.log = [...this.state.log.slice(-100), msg];
    this.updateState({ log: this.state.log });
  }

  public isWebUsbSupported(): boolean {
    return typeof navigator !== 'undefined' && 'usb' in navigator;
  }

  private async fixInterfaceNames(device: any, interfaces: any[]) {
    if (interfaces.some(intf => intf.name == null)) {
      try {
        const tempDevice = new dfu.Device(device, interfaces[0]);
        await tempDevice.device_.open();
        await tempDevice.device_.selectConfiguration(1);
        const mapping = await tempDevice.readInterfaceNames();
        await tempDevice.close();

        for (const intf of interfaces) {
          if (intf.name === null) {
            const configIndex = intf.configuration.configurationValue;
            const intfNumber = intf['interface'].interfaceNumber;
            const alt = intf.alternate.alternateSetting;
            if (mapping && mapping[configIndex] && mapping[configIndex][intfNumber]) {
              intf.name = mapping[configIndex][intfNumber][alt];
            }
          }
        }
      } catch (e) {
        console.warn('Could not read interface names:', e);
      }
    }
  }

  private async getDFUDescriptorProperties(device: any): Promise<any> {
    try {
      const data = await device.readConfigurationDescriptor(0);
      const configDesc = dfu.parseConfigurationDescriptor(data);
      let funcDesc = null;
      const configValue = device.settings.configuration.configurationValue;
      if (configDesc.bConfigurationValue == configValue) {
        for (const desc of configDesc.descriptors) {
          if (desc.bDescriptorType == 0x21 && desc.hasOwnProperty('bcdDFUVersion')) {
            funcDesc = desc;
            break;
          }
        }
      }

      if (funcDesc) {
        return {
          WillDetach: ((funcDesc.bmAttributes & 0x08) != 0),
          ManifestationTolerant: ((funcDesc.bmAttributes & 0x04) != 0),
          CanUpload: ((funcDesc.bmAttributes & 0x02) != 0),
          CanDnload: ((funcDesc.bmAttributes & 0x01) != 0),
          TransferSize: funcDesc.wTransferSize,
          DetachTimeOut: funcDesc.wDetachTimeOut,
          DFUVersion: funcDesc.bcdDFUVersion
        };
      }
    } catch (e) {
      console.warn('Failed to parse DFU descriptor:', e);
    }
    return {
      TransferSize: 1024,
      ManifestationTolerant: true
    };
  }

  // Patcher mode (FIRMWARE_PERMISSION_SWITCH = false): turn the user's stock RNDsynth-v1.3.bin into the
  // latest JG build. Throws with a user-facing message if the file or the result fails verification.
  public async patchStockFirmware(stock: ArrayBuffer): Promise<ArrayBuffer> {
    const patchUrl = `${import.meta.env.BASE_URL}firmware/${LATEST_FIRMWARE_PATCH_FILE}`;
    const resp = await fetch(patchUrl);
    if (!resp.ok) {
      throw new Error(`Failed to load patch file from ${patchUrl} (${resp.status})`);
    }
    const patch: JgPatchFile = await resp.json();
    const patched = await applyJgPatch(stock, patch);
    return patched.buffer;
  }

  public async startFlashProcess(customFirmwareBuffer?: ArrayBuffer, payloadLabel?: string): Promise<void> {
    if (!this.isWebUsbSupported()) {
      this.updateState({
        status: 'error',
        error: 'WebUSB is not supported in this browser. Please use Chrome, Edge or Opera on desktop.'
      });
      return;
    }

    try {
      this.updateState({
        status: 'connecting',
        stepText: 'Requesting USB device...',
        error: null,
        eraseProgress: 0,
        flashProgress: 0,
        bytesSent: 0,
        totalBytes: 0,
        log: ['Requesting USB device selection...']
      });

      // Request the DFU device. Closing the picker without choosing (NotFoundError) is a cancel,
      // not a reason to show a second, unfiltered picker.
      let selectedUsbDevice: any;
      try {
        selectedUsbDevice = await navigator.usb.requestDevice({
          filters: [
            { vendorId: 0x0483 }, // STMicroelectronics DFU bootloader
            { classCode: 0xfe, subclassCode: 0x01 }
          ]
        });
      } catch {
        this.updateState({
          status: 'idle',
          stepText: 'Connection cancelled.',
          error: null
        });
        return;
      }

      this.addLog(`Device selected: ${selectedUsbDevice.productName || 'USB DFU Device'} [${selectedUsbDevice.vendorId.toString(16)}:${selectedUsbDevice.productId.toString(16)}]`);

      // Find all DFU interfaces
      const interfaces = dfu.findDeviceDfuInterfaces(selectedUsbDevice);
      if (!interfaces || interfaces.length === 0) {
        throw new Error('No DFU interfaces found. Make sure the RND synth is in BOOT mode (hold BOOT while plugging in USB).');
      }

      await this.fixInterfaceNames(selectedUsbDevice, interfaces);

      // Target selection:
      // IT FLASHES TO THE: DFU: cfg=1, intf=0, alt=0, name="@Internal Flash /0x08000000/16*128Kg"
      // IT DOES NOT FLASH THE: DFU: cfg=1, intf=0, alt=1, name="@Option Bytes /0x5200201C/01*128 e"
      let targetInterface = interfaces.find((intf: any) => {
        const alt = intf.alternate.alternateSetting;
        const name = (intf.name || '').toLowerCase();
        // Specifically look for alt=0 or Internal Flash, exclude Option Bytes or alt=1
        return alt === 0 && !name.includes('option bytes');
      });

      if (!targetInterface) {
        // Fallback: search for Internal Flash / 0x08000000
        targetInterface = interfaces.find((intf: any) => {
          const name = (intf.name || '').toLowerCase();
          return (name.includes('internal flash') || name.includes('0x08000000')) && !name.includes('option bytes');
        });
      }

      if (!targetInterface) {
        // Fallback to first non-option-byte interface
        targetInterface = interfaces.find((intf: any) => intf.alternate.alternateSetting !== 1) || interfaces[0];
      }

      const targetAlt = targetInterface.alternate.alternateSetting;
      const targetName = targetInterface.name || '@Internal Flash /0x08000000/16*128Kg';
      const targetSummary = `DFU: cfg=${targetInterface.configuration.configurationValue}, intf=${targetInterface['interface'].interfaceNumber}, alt=${targetAlt}, name="${targetName}"`;

      this.addLog(`Selected Target: ${targetSummary}`);
      this.updateState({
        status: 'connected',
        targetInterfaceName: targetSummary,
        stepText: 'Target interface identified. Initializing in 1 second...'
      });

      // User instruction requirement:
      // "Once Connect is clicked, it waits a second and then picks the correct option in the flasher"
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Connect and configure DfuSe
      this.dfuseDevice = new dfuse.Device(selectedUsbDevice, targetInterface);
      await this.dfuseDevice.open();

      const descProps = await this.getDFUDescriptorProperties(this.dfuseDevice);
      const transferSize = 1024; // Explicitly configured to 1024
      const startAddress = 0x08000000; // Explicitly configured to 0x8000000
      this.dfuseDevice.startAddress = startAddress;
      const manifestationTolerant = descProps.ManifestationTolerant ?? true;

      this.addLog(`Configured: Transfer Size = ${transferSize}, Start Address = 0x${startAddress.toString(16)}`);

      // Prepare firmware data
      let firmwareBuffer: ArrayBuffer;
      if (customFirmwareBuffer && customFirmwareBuffer.byteLength > 0) {
        firmwareBuffer = customFirmwareBuffer;
        this.addLog(`Using ${payloadLabel ?? 'custom firmware payload'} (${(firmwareBuffer.byteLength / 1024).toFixed(1)} KB)`);
      } else if (!FIRMWARE_PERMISSION_SWITCH) {
        throw new Error(`Choose your stock RNDsynth-v1.3.bin first; it is patched to ${LATEST_FIRMWARE_STRING} before flashing.`);
      } else {
        this.updateState({ stepText: 'Loading latest JG-RND firmware...' });
        const firmwareUrl = `${import.meta.env.BASE_URL}firmware/${LATEST_FIRMWARE_FILE}`;
        this.addLog(`Fetching firmware from ${firmwareUrl}...`);
        const resp = await fetch(firmwareUrl);
        if (!resp.ok) {
          throw new Error(`Failed to load firmware binary from ${firmwareUrl} (${resp.status})`);
        }
        firmwareBuffer = await resp.arrayBuffer();
        this.addLog(`Loaded firmware ${LATEST_FIRMWARE_STRING} (${(firmwareBuffer.byteLength / 1024).toFixed(1)} KB)`);
      }

      this.updateState({
        totalBytes: firmwareBuffer.byteLength
      });

      // Clear any prior device error status
      try {
        const devStatus = await this.dfuseDevice.getStatus();
        if (devStatus.state === dfu.dfuERROR) {
          await this.dfuseDevice.clearStatus();
        }
      } catch {
        // Non-fatal: the download below reports any real device error
      }

      // Track phases and progress
      let currentPhase: 'erasing' | 'flashing' | 'manifesting' = 'erasing';

      this.dfuseDevice.logInfo = (msg: string) => {
        this.addLog(msg);
        if (msg.includes('Erasing')) {
          currentPhase = 'erasing';
          this.updateState({
            status: 'erasing',
            stepText: 'Erasing device flash memory...'
          });
        } else if (msg.includes('Copying data') || msg.includes('download')) {
          currentPhase = 'flashing';
          this.updateState({
            status: 'flashing',
            stepText: 'Flashing firmware to device...'
          });
        } else if (msg.includes('Manifesting')) {
          currentPhase = 'manifesting';
          this.updateState({
            status: 'manifesting',
            stepText: 'Finalizing and rebooting device...'
          });
        }
      };

      this.dfuseDevice.logProgress = (done: number, total?: number) => {
        if (!total || total === 0) return;
        const pct = Math.min(100, Math.max(0, Math.round((done / total) * 100)));

        if (currentPhase === 'erasing') {
          this.updateState({
            status: 'erasing',
            eraseProgress: pct,
            stepText: `Erasing flash memory... ${pct}%`
          });
        } else if (currentPhase === 'flashing') {
          this.updateState({
            status: 'flashing',
            flashProgress: pct,
            bytesSent: done,
            totalBytes: total,
            stepText: `Flashing firmware... ${pct}% (${Math.round(done / 1024)} KB / ${Math.round(total / 1024)} KB)`
          });
        }
      };

      // Perform download (includes automatic erase of required sectors and write chunks)
      await this.dfuseDevice.do_download(transferSize, firmwareBuffer, manifestationTolerant);

      this.addLog('Download and manifestation completed successfully.');

      // User instruction requirement:
      // "on completion it should wait a second and show UPDATE COMPLETE in blue"
      this.updateState({
        stepText: 'Finishing up...',
        eraseProgress: 100,
        flashProgress: 100
      });

      await new Promise(resolve => setTimeout(resolve, 1000));

      this.updateState({
        status: 'complete',
        stepText: 'UPDATE COMPLETE',
        eraseProgress: 100,
        flashProgress: 100
      });

      await this.closeDevice();
    } catch (err: any) {
      console.error('DFU Flash Error:', err);
      // Release the USB interface so CONNECT can be retried without replugging
      await this.closeDevice();
      const errMsg = err?.message || String(err);
      this.addLog(`ERROR: ${errMsg}`);
      this.updateState({
        status: 'error',
        error: errMsg,
        stepText: `Error: ${errMsg}`
      });
    }
  }

  private async closeDevice(): Promise<void> {
    if (!this.dfuseDevice) return;
    try {
      await this.dfuseDevice.close();
    } catch {
      // The device disconnecting after its reset is normal
    }
    this.dfuseDevice = null;
  }

  public resetState() {
    this.updateState({
      status: 'idle',
      stepText: 'Ready to connect',
      eraseProgress: 0,
      flashProgress: 0,
      bytesSent: 0,
      totalBytes: 0,
      error: null,
      targetInterfaceName: null,
      log: []
    });
  }
}

export const flasherService = new FlasherService();
