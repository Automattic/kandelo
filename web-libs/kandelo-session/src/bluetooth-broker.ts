/**
 * Page-side broker for `/dev/kandelo/bluetooth`.
 *
 * Web Bluetooth objects live on the page's main thread and cannot cross into
 * the kernel worker, so the page holds the paired device and runs every GATT
 * operation here. The loop waits for the next guest request (a UTF-8 command
 * line), runs it, and pushes the answer back as a `KIND_RESPONSE` with the
 * request's id. Characteristic notifications and connection changes are
 * pushed unsolicited as `KIND_NOTIFY` / `KIND_STATUS`.
 *
 * Commands (UUIDs may be 128-bit strings, 16-bit hex like `0x180f`, or Web
 * Bluetooth names like `battery_service`):
 *
 *   info                         ok name=<name> connected=<0|1>
 *   services                     ok <uuid> ...
 *   chars <svc>                  ok <uuid>:<prop,prop> ...
 *   read <svc> <chr>             ok <hex>
 *   write <svc> <chr> <hex>      ok
 *   notify <svc> <chr> on|off    ok      (then: notify <svc> <chr> <hex>)
 *   disconnect                   ok
 *
 * Failures answer `err <message>`.
 */

/** Host -> guest record kinds; mirror `KANDELO_BLUETOOTH_KIND_*`. */
export const BLUETOOTH_KIND_RESPONSE = 2;
export const BLUETOOTH_KIND_NOTIFY = 3;
export const BLUETOOTH_KIND_STATUS = 4;

/**
 * Services a page must name at pairing time to be allowed to use them later
 * (`requestDevice({ optionalServices })`). A device's other services are
 * invisible to the page, so `services` only ever lists these.
 */
export const DEFAULT_BLUETOOTH_OPTIONAL_SERVICES: readonly (string | number)[] = [
  "battery_service",
  "device_information",
  "heart_rate",
  "environmental_sensing",
  "health_thermometer",
  "cycling_speed_and_cadence",
  "cycling_power",
  "running_speed_and_cadence",
  "human_interface_device",
  "generic_access",
  "generic_attribute",
  0xfe59, // Nordic DFU
  "6e400001-b5a3-f393-e0a9-e50e24dcca9e", // Nordic UART
];

// Minimal structural Web Bluetooth types, so this file needs no DOM lib extras.
interface GattCharacteristic extends EventTarget {
  uuid: string;
  value?: DataView | null;
  properties: Record<string, boolean>;
  readValue(): Promise<DataView>;
  writeValue(data: BufferSource): Promise<void>;
  startNotifications(): Promise<GattCharacteristic>;
  stopNotifications(): Promise<GattCharacteristic>;
}
interface GattService {
  uuid: string;
  getCharacteristic(uuid: string | number): Promise<GattCharacteristic>;
  getCharacteristics(): Promise<GattCharacteristic[]>;
}
interface GattServer {
  connected: boolean;
  connect(): Promise<GattServer>;
  disconnect(): void;
  getPrimaryService(uuid: string | number): Promise<GattService>;
  getPrimaryServices(): Promise<GattService[]>;
}
export interface BluetoothDeviceLike extends EventTarget {
  name?: string;
  gatt?: GattServer;
}

/** What the broker needs from the kernel host (LiveKernelHost provides it). */
export interface BluetoothBrokerHost {
  pushBluetoothRecord(kind: number, seq: number, text: string): Promise<{ ok: boolean; reason?: string }>;
  waitForBluetoothRequest(options?: { timeoutMs?: number }): Promise<
    | { ok: true; request: { seq: number; command: string } }
    | { ok: false; reason: string }
  >;
}

export interface BluetoothBroker {
  readonly device: BluetoothDeviceLike;
  stop(): void;
}

const NO_AGENT_RETRY_MS = 500;

function uuidArg(text: string | undefined): string | number {
  if (!text) throw new Error("missing service/characteristic");
  if (/^0x[0-9a-f]{1,8}$/i.test(text)) return Number.parseInt(text, 16);
  return text.toLowerCase();
}

function toHex(view: DataView): string {
  let out = "";
  for (let i = 0; i < view.byteLength; i++) out += view.getUint8(i).toString(16).padStart(2, "0");
  return out;
}

function fromHex(hex: string | undefined): Uint8Array {
  if (!hex || !/^([0-9a-f]{2})+$/i.test(hex)) throw new Error("value must be even-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Connect to `device`'s GATT server and broker it to whichever guest process
 * opens `/dev/kandelo/bluetooth`. Returns once connected; the request loop
 * runs until `stop()` or the device disconnects.
 */
export async function startBluetoothBroker(
  host: BluetoothBrokerHost,
  device: BluetoothDeviceLike,
  log: (message: string) => void = () => {},
): Promise<BluetoothBroker> {
  const gatt = device.gatt;
  if (!gatt) throw new Error("device has no GATT server");
  const server = await gatt.connect();
  const name = device.name || "unnamed";
  let stopped = false;
  const subscriptions = new Map<string, { chr: GattCharacteristic; listener: EventListener }>();

  const push = (kind: number, seq: number, text: string) =>
    host.pushBluetoothRecord(kind, seq, text).then((r) => {
      if (!r.ok && r.reason !== "no-agent") log(`bluetooth push failed: ${r.reason}`);
      return r;
    });

  const onDisconnect = () => {
    log(`bluetooth: ${name} disconnected`);
    void push(BLUETOOTH_KIND_STATUS, 0, "disconnected");
    stopped = true;
  };
  device.addEventListener("gattserverdisconnected", onDisconnect);
  void push(BLUETOOTH_KIND_STATUS, 0, `connected ${name}`);
  log(`bluetooth: connected to ${name}`);

  const characteristic = async (svc: string | undefined, chr: string | undefined) =>
    (await server.getPrimaryService(uuidArg(svc))).getCharacteristic(uuidArg(chr));

  async function run(command: string): Promise<string> {
    const [op, a, b, c] = command.trim().split(/\s+/);
    switch (op) {
      case "info":
        return `ok name=${name.replace(/\s+/g, "_")} connected=${server.connected ? 1 : 0}`;
      case "services": {
        const services = await server.getPrimaryServices();
        return `ok ${services.map((s) => s.uuid).join(" ")}`.trimEnd();
      }
      case "chars": {
        const chars = await (await server.getPrimaryService(uuidArg(a))).getCharacteristics();
        return `ok ${chars
          .map((ch) => `${ch.uuid}:${Object.keys(ch.properties).filter((k) => ch.properties[k]).join(",")}`)
          .join(" ")}`.trimEnd();
      }
      case "read":
        return `ok ${toHex(await (await characteristic(a, b)).readValue())}`;
      case "write":
        await (await characteristic(a, b)).writeValue(fromHex(c));
        return "ok";
      case "notify": {
        const key = `${a} ${b}`;
        const chr = await characteristic(a, b);
        if (c === "off") {
          const sub = subscriptions.get(key);
          if (sub) {
            sub.chr.removeEventListener("characteristicvaluechanged", sub.listener);
            subscriptions.delete(key);
            await chr.stopNotifications();
          }
          return "ok";
        }
        if (c !== "on") throw new Error("usage: notify <svc> <chr> on|off");
        if (!subscriptions.has(key)) {
          const listener: EventListener = () => {
            if (chr.value) void push(BLUETOOTH_KIND_NOTIFY, 0, `notify ${a} ${b} ${toHex(chr.value)}`);
          };
          chr.addEventListener("characteristicvaluechanged", listener);
          subscriptions.set(key, { chr, listener });
          await chr.startNotifications();
        }
        return "ok";
      }
      case "disconnect":
        server.disconnect();
        return "ok";
      default:
        throw new Error(`unknown command '${op ?? ""}' (info|services|chars|read|write|notify|disconnect)`);
    }
  }

  void (async () => {
    while (!stopped) {
      const next = await host.waitForBluetoothRequest();
      if (stopped) break;
      if (!next.ok) {
        if (next.reason === "unsupported") {
          log("bluetooth: this kernel has no /dev/kandelo/bluetooth support");
          break;
        }
        if (next.reason === "no-agent") await new Promise((r) => setTimeout(r, NO_AGENT_RETRY_MS));
        continue; // timeout / invalid-request: wait again
      }
      const { seq, command } = next.request;
      let answer: string;
      try {
        answer = await run(command);
      } catch (error) {
        answer = `err ${error instanceof Error ? error.message : String(error)}`;
      }
      await push(BLUETOOTH_KIND_RESPONSE, seq, answer);
    }
  })();

  return {
    device,
    stop() {
      stopped = true;
      device.removeEventListener("gattserverdisconnected", onDisconnect);
      for (const { chr, listener } of subscriptions.values()) {
        chr.removeEventListener("characteristicvaluechanged", listener);
      }
      subscriptions.clear();
      if (server.connected) server.disconnect();
    },
  };
}
