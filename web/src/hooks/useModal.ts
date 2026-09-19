import { type RefObject, useEffect, useRef } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * What every modal surface owes the keyboard (the settings drawer, the shell's menu below md): focus moves
 * into the panel when it opens, Tab and Shift-Tab wrap inside it, Escape closes it, the page behind stops
 * scrolling, and focus returns to whatever opened it when it closes. Installed once per opening; `onClose`
 * is read through a ref so a re-render of the panel's contents never re-runs the trap and yanks focus back.
 *
 * `active` gates the whole thing for panels that stay mounted while closed; pass `true` for one that mounts
 * only while open. The panel element needs `tabIndex={-1}` to take focus itself.
 */
export function useModal(panel: RefObject<HTMLElement | null>, onClose: () => void, active = true): void {
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const el = panel.current;
    if (!active || !el) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    el.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const focused = document.activeElement;
      const inside = focused instanceof Node && el.contains(focused);
      if (e.shiftKey && (focused === first || focused === el || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (focused === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [panel, active]);
}
