// The few strings and class lists that more than one page shares. Anything used from one place stays in
// that place; anything that grows a variant here should become a component or a token instead.

/** Why every start control is disabled without a key; the rail footer, the Agents page and the wizard all say it. */
export const NO_KEY_LINE = "Set WANDB_API_KEY to run live; replays still play";

/** The one filled button a page may have (emphasis budget): Connect agent, Continue, Save, Heal. */
export const primaryButton =
  "inline-flex h-9 items-center rounded-lg bg-[var(--fg)] px-4 text-[13px] font-medium text-[var(--bg)] transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40 disabled:hover:opacity-40";

/** The header's second action beside `primaryButton`: same height and radius, hairline edge instead of fill. */
export const secondaryButton =
  "inline-flex h-9 items-center rounded-lg border border-[var(--border)] bg-transparent px-4 text-[13px] font-medium text-[var(--muted)] transition-colors hover:border-[var(--border-2)] hover:text-[var(--fg)] disabled:cursor-default disabled:opacity-40";

/** A quiet text button: muted, brightens on hover; faint and inert when disabled. The `.u-line` wipe goes only on a surface's one primary text action. */
export const textButton =
  "group rounded text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:cursor-default disabled:text-[var(--faint)] disabled:hover:text-[var(--faint)]";

/** The one text input: a tall inset surface, hairline edge that brightens and gains a soft ring on focus (the wizard, the token form, the dialogs). */
export const textInput =
  "h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--inset)] px-4 text-[14px] text-[var(--fg)] outline-none transition-[border-color,box-shadow] placeholder:text-[var(--faint)] focus:border-[var(--border-2)] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]";

/** The label over a `textInput`: the field's name, in the foreground weight the reference forms use. */
export const fieldLabel = "text-[14px] font-medium text-[var(--fg)]";

/** The one display size: the Cycle page's headline, and the verdict wherever an agent is judged (plan 12 §6). */
export const displayHead = "text-[28px] font-medium leading-[1.2] tracking-[-0.02em] text-[var(--fg)]";

/** The tracked eyebrow over a section, a table or a strip of facts: small caps in the faint shade, never bold. */
export const eyebrow = "text-[11px] uppercase tracking-[0.08em] text-[var(--faint)]";

/** A badge (`v0 → v2`, a gate result): a filled inset pill, no outline — an outlined pill on black is another line. */
export const pill = "tabular inline-flex items-center gap-1 rounded-full bg-[var(--inset)] px-2 py-0.5 text-[11.5px] leading-[1.4] text-[var(--muted)]";

/** The surface a table or a strip of facts sits on: the same step off the floor as `Panel`, without the title row. */
export const surface = "rounded-xl border border-[var(--frame)] bg-[var(--card)]";

/** A quiet bordered button beside a field (Ping, Copy): the input's own edge, the text button's colours. */
export const outlineButton =
  "inline-flex h-11 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 text-[13px] font-medium text-[var(--fg)] transition-colors hover:border-[var(--border-2)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40 disabled:hover:border-[var(--border)] disabled:hover:bg-[var(--card)]";
