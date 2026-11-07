/** Test-only output policy. The guest PCM stream and upstream analysers stay
 * live; only connections to the physical Web Audio destination are silenced.
 * Installed by Playwright rather than an HTML transform so public fixtures,
 * reused servers, previews, popups and child frames receive the same policy.
 */
export const SILENT_AUDIO_INIT_SCRIPT = String.raw`(() => {
  if (typeof AudioNode === "undefined") return;
  const key = Symbol.for("kandelo.playwright.silent-audio");
  if (globalThis[key]) return;
  const RealtimeContext = AudioContext;
  const Destination = AudioDestinationNode;
  const nativeConnect = AudioNode.prototype.connect;
  const nativeDisconnect = AudioNode.prototype.disconnect;
  const mutes = new WeakMap();
  const muteFor = (dest) =>
    dest instanceof Destination && dest.context instanceof RealtimeContext
      ? mutes.get(dest.context) ?? (() => {
        const mute = dest.context.createGain();
        mute.gain.value = 0;
        nativeConnect.call(mute, dest);
        mutes.set(dest.context, mute);
        return mute;
      })()
      : null;
  const wrap = (proto) => {
    const connect = proto.connect;
    proto.connect = function (dest, ...rest) {
      const mute = muteFor(dest);
      if (mute !== null && this !== mute) {
        // Never connect a live source directly to the speakers, even briefly.
        connect.call(this, mute, ...rest);
        return dest; // AudioNode.connect() returns its requested destination.
      }
      return connect.call(this, dest, ...rest);
    };
  };
  wrap(AudioNode.prototype);
  for (const name of Object.getOwnPropertyNames(globalThis)) {
    if (!name.endsWith("Node")) continue;
    const proto = globalThis[name]?.prototype;
    if (proto instanceof AudioNode && Object.hasOwn(proto, "connect")) wrap(proto);
  }
  AudioNode.prototype.disconnect = function (...args) {
    const mute = args.length > 0 ? muteFor(args[0]) : null;
    if (mute !== null && this !== mute) args[0] = mute;
    return nativeDisconnect.apply(this, args);
  };
  globalThis[key] = { mutes };
})();`;
