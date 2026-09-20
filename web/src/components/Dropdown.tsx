import { Check } from "@phosphor-icons/react";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { useMotionPref } from "@/hooks/useMotionPref";
import { cn } from "@/lib/utils";

export interface DropdownOption<V extends string = string> {
  value: V;
  /** Plain text: what typeahead matches and what the trigger reads when no `row` is given. */
  label: string;
  /** Rich rendering for the row; falls back to `label`. */
  row?: ReactNode;
  disabled?: boolean;
  /** Small text after the row (e.g. `stopped`). */
  aside?: string;
}

/**
 * The app's one listbox. A trigger (the caller's JSX) and a floating panel of options: ↑/↓ move, Home/End
 * jump, typing jumps to the first label with that prefix, Enter picks, Escape or a click outside closes, Tab
 * walks into the footer's links and out again (closing on the way out). Closing from the keyboard hands focus
 * back to the trigger. The panel opens below and flips above when the viewport is short; `placement="right"`
 * opens beside the trigger (the collapsed rail). `footer` sits under the list, outside the listbox, for links.
 */
export default function Dropdown<V extends string>({
  value,
  options,
  onChange,
  label,
  trigger,
  disabled = false,
  placement = "below",
  align = "start",
  panelWidth = 228,
  footer,
  className,
}: {
  value: V | null;
  options: DropdownOption<V>[];
  onChange: (value: V) => void;
  /** Accessible name for the listbox. */
  label: string;
  /** Renders the closed control; receives `open` so it can rotate a caret or highlight. */
  trigger: (state: { open: boolean; selected: DropdownOption<V> | null }) => ReactNode;
  disabled?: boolean;
  placement?: "below" | "right";
  /** Which trigger edge the panel shares when `below`. */
  align?: "start" | "center" | "end";
  panelWidth?: number;
  /** Links under the list, outside the listbox; any click inside it closes the panel. */
  footer?: ReactNode;
  className?: string;
}) {
  const reduced = useMotionPref();
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState(false);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const [active, setActive] = useState(Math.max(0, selectedIndex));
  const typed = useRef({ text: "", at: 0 });

  // A pointer outside chose somewhere else to be; every other close (pick, Escape, Tab out) came from the
  // keyboard or from inside the panel, and focus belongs back on the trigger.
  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }, []);
  const toggle = () => {
    if (disabled) return;
    setActive(Math.max(0, selectedIndex));
    setOpen((o) => !o);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !rootRef.current?.contains(e.target)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  // Flip above when the panel would run off the bottom of the viewport; measured once per open.
  useLayoutEffect(() => {
    if (!open || placement !== "below") return;
    const root = rootRef.current?.getBoundingClientRect();
    const panel = panelRef.current?.getBoundingClientRect();
    if (!root || !panel) return;
    setFlip(root.bottom + 4 + panel.height > window.innerHeight - 8 && root.top - 4 - panel.height > 8);
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const enabled = (i: number) => !options[i]?.disabled;
  const step = (from: number, dir: 1 | -1) => {
    for (let n = 1; n <= options.length; n++) {
      const i = (from + dir * n + options.length) % options.length;
      if (enabled(i)) return i;
    }
    return from;
  };
  const edge = (dir: 1 | -1) => {
    const order = dir === 1 ? options.map((_, i) => i) : options.map((_, i) => options.length - 1 - i);
    return order.find(enabled) ?? active;
  };
  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    close();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => step(a, 1));
        return;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => step(a, -1));
        return;
      case "Home":
        e.preventDefault();
        setActive(edge(1));
        return;
      case "End":
        e.preventDefault();
        setActive(edge(-1));
        return;
      case "Enter":
      case " ":
        e.preventDefault();
        pick(active);
        return;
      case "Escape":
        e.preventDefault();
        close();
        return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 600 ? typed.current.text : "") + e.key.toLowerCase(), at: now };
      const q = typed.current.text;
      const from = q.length === 1 ? active + 1 : active;
      for (let n = 0; n < options.length; n++) {
        const i = (from + n) % options.length;
        if (enabled(i) && options[i].label.toLowerCase().startsWith(q)) {
          setActive(i);
          return;
        }
      }
    }
  };

  const right = placement === "right";
  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        onKeyDown={(e) => {
          if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !open) {
            e.preventDefault();
            toggle();
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        disabled={disabled}
        className="block w-full rounded-md text-left disabled:cursor-default"
      >
        {trigger({ open, selected })}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            onKeyDown={onKey}
            onBlur={(e) => {
              // Tab out of the panel (past the footer) closes it; focus is already where the user sent it.
              if (!rootRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
            }}
            initial={{ opacity: 0, y: flip ? 4 : -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: flip ? 4 : -4 }}
            transition={{ duration: reduced ? 0 : 0.12 }}
            style={{ width: panelWidth }}
            className={cn(
              "absolute z-40 flex max-h-[min(360px,60vh)] flex-col overflow-y-auto rounded-lg font-sans text-[13px] font-normal tracking-normal border border-[var(--border-2)] bg-[var(--card)] p-1 shadow-[0_8px_32px_rgba(0,0,0,.5)] outline-none",
              right ? "left-full top-0 ml-2" : flip ? "bottom-full mb-1" : "top-full mt-1",
              !right && (align === "end" ? "right-0" : align === "center" ? "left-1/2 -translate-x-1/2" : "left-0"),
            )}
          >
            {/* The listbox holds options only (ARIA); the footer is a sibling below it in the same panel. */}
            <div ref={listRef} id={`${id}-list`} role="listbox" aria-label={label} aria-activedescendant={`${id}-opt-${active}`} tabIndex={-1} className="flex flex-col gap-0.5 outline-none">
              {options.map((o, i) => {
                const on = o.value === value;
                const hot = i === active;
                return (
                  <div
                    key={o.value}
                    id={`${id}-opt-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={on}
                    aria-disabled={o.disabled || undefined}
                    onPointerMove={() => !o.disabled && setActive(i)}
                    onClick={() => pick(i)}
                    className={cn(
                      "flex h-9 cursor-default items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors",
                      hot && !o.disabled ? "bg-[var(--hover)] text-[var(--fg)]" : on ? "text-[var(--fg)]" : "text-[var(--muted)]",
                      o.disabled && "opacity-50",
                    )}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2.5 truncate">{o.row ?? o.label}</span>
                    {o.aside && <span className="shrink-0 text-[11px] text-[var(--faint)]">{o.aside}</span>}
                    <Check size={14} weight="bold" className={cn("shrink-0", on ? "text-[var(--fg)]" : "invisible")} aria-hidden />
                  </div>
                );
              })}
            </div>
            {footer && (
              <div onClick={() => close()}>
                <span aria-hidden className="my-1 block h-px bg-[var(--border)]" />
                {footer}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
