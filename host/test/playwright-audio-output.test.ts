import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { SILENT_AUDIO_INIT_SCRIPT } from "../../apps/browser-demos/playwright-audio";

// Model native graph calls to check that no transient direct speaker edge is
// created. Actual PCM processing is checked in test-audio-policy.spec.ts on
// Chromium, Firefox and WebKit; this model never creates a hardware source.
function graph() {
  const connections: Array<{ from: AudioNode; to: AudioNode; gain?: number }> = [];
  const disconnections: Array<{ from: AudioNode; to?: AudioNode }> = [];
  class AudioNode {
    constructor(readonly context: object) {}
    connect(to: AudioNode): AudioNode {
      connections.push({ from: this, to, gain: this instanceof GainNode ? this.gain.value : undefined });
      return to;
    }
    disconnect(to?: AudioNode) { disconnections.push({ from: this, to }); }
  }
  class AudioDestinationNode extends AudioNode {}
  class GainNode extends AudioNode { gain = { value: 1 }; }
  class AudioContext {
    destination = new AudioDestinationNode(this);
    createGain() { return new GainNode(this); }
  }
  const scope = { AudioNode, AudioDestinationNode, GainNode, AudioContext };
  const vm = createContext(scope);
  runInContext(SILENT_AUDIO_INIT_SCRIPT, vm);
  return { scope, vm, connections, disconnections, AudioNode, GainNode, AudioContext, AudioDestinationNode };
}

describe("test speaker-output policy", () => {
  it("routes through gain zero before any source can reach the physical destination", () => {
    const g = graph();
    const context = new g.AudioContext();
    const source = new g.AudioNode(context);
    expect(source.connect(context.destination)).toBe(context.destination);
    expect(g.connections).toHaveLength(2);
    const physical = g.connections.filter(edge => edge.to === context.destination);
    expect(physical).toHaveLength(1);
    expect(physical[0].from).toBeInstanceOf(g.GainNode);
    expect(physical[0].gain).toBe(0);
    expect(g.connections[1]).toMatchObject({ from: source, to: physical[0].from });
    source.disconnect(context.destination);
    expect(g.disconnections.at(-1)).toEqual({ from: source, to: physical[0].from });
  });

  it("stays muted when a test wraps the AudioContext constructor, and installs only once", () => {
    const g = graph();
    const context = new g.AudioContext();
    Object.assign(g.scope, { AudioContext: function ContextProbe() { return context; } });
    runInContext(SILENT_AUDIO_INIT_SCRIPT, g.vm);
    new g.AudioNode(context).connect(context.destination);
    expect(g.connections.filter(edge => edge.to === context.destination))
      .toMatchObject([{ gain: 0 }]);
  });

  it("leaves offline processing and non-speaker connections intact", () => {
    const g = graph();
    const offlineContext = {};
    const offlineDestination = new g.AudioDestinationNode(offlineContext);
    const source = new g.AudioNode(offlineContext);
    expect(source.connect(offlineDestination)).toBe(offlineDestination);
    expect(g.connections).toEqual([{ from: source, to: offlineDestination, gain: undefined }]);
  });
});
