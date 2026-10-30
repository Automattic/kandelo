import * as React from "react";

export function useDialogDismiss(dialog: React.RefObject<HTMLDialogElement | null>, onClose: () => void, dismissible = true) {
  const backdropPointer = React.useRef<number | null>(null);
  const backdropClick = React.useRef(false);
  const previousFocus = React.useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  React.useEffect(() => () => {
    if (previousFocus.current?.isConnected) previousFocus.current.focus();
  }, []);
  const close = () => {
    if (!dismissible) return;
    dialog.current?.close();
    onClose();
  };
  const isBackdrop = (event: React.MouseEvent<HTMLDialogElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return event.target === event.currentTarget && (
      event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom
    );
  };
  return {
    close,
    onCancel(event: React.SyntheticEvent<HTMLDialogElement>) {
      event.preventDefault();
      close();
    },
    onPointerDown(event: React.PointerEvent<HTMLDialogElement>) {
      backdropClick.current = false;
      backdropPointer.current = isBackdrop(event) ? event.pointerId : null;
    },
    onPointerUp(event: React.PointerEvent<HTMLDialogElement>) {
      backdropClick.current = backdropPointer.current === event.pointerId && isBackdrop(event);
      backdropPointer.current = null;
    },
    onClick(event: React.MouseEvent<HTMLDialogElement>) {
      const dismiss = backdropClick.current && isBackdrop(event);
      backdropClick.current = false;
      if (dismiss) {
        event.preventDefault();
        close();
      }
    },
    onPointerCancel() {
      backdropPointer.current = null;
      backdropClick.current = false;
    },
  };
}
