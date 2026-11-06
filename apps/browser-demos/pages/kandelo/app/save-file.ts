/**
 * Save bytes from the machine to the user's disk. Chromium's
 * `showSaveFilePicker` streams to disk; elsewhere the bytes are saved through
 * a Blob and `<a download>`.
 *
 * The picker opens before `read()` is called, while the click that asked for
 * the save still counts as user activation.
 */

type SaveFilePicker = (options: { suggestedName?: string }) => Promise<{
  createWritable(): Promise<WritableStream<Uint8Array>>;
}>;

/** False when the user cancelled the save dialog. */
export async function saveFile(name: string, mimeType: string | undefined, read: () => ReadableStream<Uint8Array>): Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (picker) {
    let handle;
    try {
      handle = await picker({ suggestedName: name });
    } catch (error) {
      // Only a cancelled dialog is quiet; a refusal (SecurityError when the
      // page lacks activation, say) is shown to the caller.
      if (error instanceof DOMException && error.name === "AbortError") return false;
      throw error;
    }
    await read().pipeTo(await handle.createWritable());
    return true;
  }
  // No streaming save here: the whole file is held in memory once.
  const blob = await new Response(read()).blob();
  const typed = mimeType ? new Blob([blob], { type: mimeType }) : blob;
  const url = URL.createObjectURL(typed);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export function canStreamSave(): boolean {
  return Boolean((window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker);
}
