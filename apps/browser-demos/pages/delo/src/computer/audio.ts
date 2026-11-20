// The sound of a delo computer: what a program writes to /dev/dsp plays
// through the host's machine-level PCM sink, and is heard only while the
// sound tool is on. The browser starts Web Audio only after a trusted
// gesture, so the first click or key press on the page starts the sink, with
// the sound tool or without it: a suspended sink would make a program that
// writes to /dev/dsp wait. The tool starts off and only mutes the sink.
// Without the sound option there is no tool and the sink stays muted. A
// failure shows once a program has opened the audio device. Returns the
// switch the sound tool and the agent's option_sound_set share.

import type { KernelHost } from "../../../../../../web-libs/kandelo-session/src/kernel-host";

export function wireAudio(host: KernelHost, button: HTMLButtonElement | null, report: (message: string) => void): (on: boolean) => void {
  let on = false;
  const fail = (error: unknown) => {
    if (host.getAudioActivity()) report(error instanceof Error ? error.message : String(error));
  };
  const resume = () => {
    if (host.getAudioState() === "running") return;
    host.resumeAudio().catch(fail);
  };
  const render = () => {
    if (host.getAudioState() === "unavailable") fail("this browser cannot play the computer's sound");
    button?.setAttribute("aria-pressed", String(on));
  };
  const set = (next: boolean) => {
    on = next;
    host.setAudioMuted(!on);
    render();
  };
  button?.addEventListener("click", () => set(!on));
  host.setAudioMuted(true);
  window.addEventListener("pointerdown", resume, { capture: true });
  window.addEventListener("keydown", resume, { capture: true });
  host.subscribeAudioState(render);
  host.subscribeAudioActivity(render);
  render();
  return set;
}
