// AudioWorklet processor for repro.html. It outputs silence, and it answers
// every message on its port, so the page can tell whether the worklet's
// rendering thread is still running after its AudioContext was closed.
class Silence extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = ({ data }) => this.port.postMessage({ pong: data });
  }

  process() {
    return true;
  }
}
registerProcessor('silence', Silence);
