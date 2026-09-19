// The few strings and class lists that more than one page shares. Anything used from one place stays in
// that place; anything that grows a variant here should become a component or a token instead.

/** Why every start control is disabled without a key; the rail footer, the Agents page and the wizard all say it. */
export const NO_KEY_LINE = "Set WANDB_API_KEY to run live; replays still play";

/** The one filled button a page may have (emphasis budget): Connect agent, Continue, Save, Heal. */
export const primaryButton =
  "inline-flex h-9 items-center rounded-lg bg-[var(--fg)] px-4 text-[13px] font-medium text-[var(--bg)] transition-opacity hover:opacity-85 disabled:cursor-default disabled:opacity-40 disabled:hover:opacity-40";

/** A quiet text button: muted, brightens on hover, the `.u-line` wipe on its label span; faint and inert when disabled. */
export const textButton =
  "group rounded text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--fg)] disabled:cursor-default disabled:text-[var(--faint)] disabled:hover:text-[var(--faint)]";
