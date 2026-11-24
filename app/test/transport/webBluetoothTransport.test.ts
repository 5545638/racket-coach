import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoachController } from '../../src/app/controller';
import { SilentSpeaker } from '../../src/feedback/speech';
import {
  Command,
  CONTROL_CHARACTERISTIC_UUID,
  DATA_CHARACTERISTIC_UUID,
} from '../../src/protocol/constants';
import type { LinkEvent } from '../../src/protocol/link';
import { decodeCommandV2 } from '../../src/protocol/messagesV2';
import { WebBluetoothTransport } from '../../src/transport/webBluetoothTransport';
import { InMemoryRepository } from '../fakes';
import { FirmwareHarness, pulseMotion } from '../firmware/firmwareHarness';

/**
 * A fake Web Bluetooth stack whose GATT characteristics are wired to the
 * firmware harness: the real transport talks to the real firmware.
 */
function fakeBluetooth(fw: FirmwareHarness) {
  const listeners = new Set<(event: unknown) => void>();
  const withResponse: Uint8Array[] = [];
  const withoutResponse: Uint8Array[] = [];
  const data = {
    addEventListener: (_type: string, l: (event: unknown) => void) => listeners.add(l),
    removeEventListener: (_type: string, l: (event: unknown) => void) => listeners.delete(l),
    startNotifications: () => Promise.resolve(data),
  };
  const control = {
    writeValueWithResponse: (v: Uint8Array) => {
      withResponse.push(v.slice());
      fw.write(v);
      return Promise.resolve();
    },
    writeValueWithoutResponse: (v: Uint8Array) => {
      withoutResponse.push(v.slice());
      fw.write(v);
      return Promise.resolve();
    },
  };
  fw.onNotify((p) => {
    const value = new DataView(p.slice().buffer);
    for (const l of listeners) l({ target: { value } });
  });
  const service = {
    getCharacteristic: (uuid: string) =>
      uuid === DATA_CHARACTERISTIC_UUID
        ? Promise.resolve(data)
        : uuid === CONTROL_CHARACTERISTIC_UUID
          ? Promise.resolve(control)
          : Promise.reject(new Error(`unknown characteristic ${uuid}`)),
  };
  const server = { getPrimaryService: () => Promise.resolve(service) };
  const device = {
    name: 'RacketCoach 5678',
    gatt: {
      connect: () => {
        fw.connectLink();
        return Promise.resolve(server);
      },
      disconnect: () => {
        fw.disconnect();
      },
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  vi.stubGlobal('navigator', { bluetooth: { requestDevice: () => Promise.resolve(device) } });
  return { withResponse, withoutResponse };
}

/** Advances virtual time in small steps, letting promise chains (GATT writes) settle. */
async function run(fw: FirmwareHarness, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 10) {
    fw.run(10);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WebBluetoothTransport against the firmware harness', () => {
  it('sends HELLO without response, negotiates v2, ACKs and delivers a capture', async () => {
    const fw = new FirmwareHarness();
    fw.imu.motion = pulseMotion([{ t: 4, peakDps: 1500, sigmaS: 0.05 }]);
    const fake = fakeBluetooth(fw);
    const transport = new WebBluetoothTransport(fw.clock.linkClock);
    const events: LinkEvent[] = [];
    transport.onEvent((e) => events.push(e));
    await transport.connect();
    await transport.send(Uint8Array.of(Command.RequestStatus));
    await run(fw, 7000);

    expect(Array.from(fake.withoutResponse[0] ?? [])).toEqual([0x10, 2, 0]);
    expect(fake.withResponse.map((b) => Array.from(b))).toEqual([[Command.RequestStatus]]);
    const types = new Set(fake.withoutResponse.map((b) => decodeCommandV2(b)?.type));
    expect([...types].sort()).toEqual(['ack', 'done', 'hello']);
    expect(events.find((e) => e.type === 'protocol')).toEqual({ type: 'protocol', version: 2 });
    const captures = events.flatMap((e) => (e.type === 'capture' ? [e.capture] : []));
    expect(captures).toHaveLength(1);
    expect(captures[0]?.protocolVersion).toBe(2);
    await transport.disconnect();
  });

  it('lets the controller show STATUS2 diagnostics and switch to M416 from the settings', async () => {
    const fw = new FirmwareHarness();
    fakeBluetooth(fw);
    const controller = new CoachController({
      repository: new InMemoryRepository(),
      speaker: new SilentSpeaker(),
      now: () => 1_700_000_000_000,
      newId: () => 'id',
      sleep: () => Promise.resolve(),
    });
    await controller.init();
    await controller.connect(new WebBluetoothTransport(fw.clock.linkClock));
    await run(fw, 1000);
    expect(controller.protocolVersion.value).toBe(2);
    expect(controller.status.value?.firmwareVersion).toBe('0.2.0');
    expect(controller.diagnostics.value).toMatchObject({ mode: 'M104', payloadBytes: 48 });
    await controller.updateSettings({ experimentalM416: true });
    await run(fw, 500);
    expect(controller.diagnostics.value?.mode).toBe('M416');
    controller.runBench(8);
    await run(fw, 200);
    expect(controller.log.value[0]?.text).toMatch(/Bench T8 part 254/);
    controller.runBench(5, 3);
    await run(fw, 3000);
    expect(controller.log.value[0]?.text).toMatch(/Bench T5 part 255: .*received 200 of 200/);
    await controller.disconnect();
  });
});
