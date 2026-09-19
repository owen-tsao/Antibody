import { useEffect } from "react";

import { api, type LoopState } from "@/api";
import { usePoll } from "@/hooks/usePoll";
import { isFirstRun } from "@/lib/derive";
import { AGENTS, LIVE_RUN, linkProps, onboarding, onboardingSkipped, replace, RUNS } from "@/lib/routes";

const POLL_MS = 15_000;

/**
 * `/app/home`. A minimal titled page until Block 4 fills it in; what it does own is the first-run rule
 * (Block 3.4): nothing connected, no history beyond the demo tape, nothing running → the wizard, via
 * `replaceState` so Back does not bounce through here. Renders nothing until the rule can be decided,
 * so the page never flashes before redirecting.
 */
export default function Home({ loop }: { loop: LoopState | null }) {
  const { data: agents } = usePoll(api.agents, POLL_MS);
  const { data: runs } = usePoll(api.runs, POLL_MS);
  const firstRun = isFirstRun(agents, runs, loop);
  const redirect = firstRun === true && !onboardingSkipped();

  useEffect(() => {
    if (redirect) replace(onboarding(1));
  }, [redirect]);

  if (firstRun === null || redirect) return null;

  const links = [
    loop?.running ? { to: LIVE_RUN, label: "Watch the current run" } : null,
    { to: RUNS, label: "Start a run" },
    { to: AGENTS, label: "Your agents" },
  ].filter((l) => l !== null);

  return (
    <main className="px-6 pb-16 pt-8 md:px-10 md:pt-7">
      <div className="mx-auto w-full max-w-[1040px]">
        <h1 className="display text-[48px] leading-[1]">Home</h1>
        <p className="mt-4 max-w-[56ch] text-[13px] leading-[1.6] text-[var(--muted)]">
          Antibody attacks your support agent in a sandbox storefront and ships only the patches that fix a failure without breaking anything that worked.
        </p>
        <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
          {links.map((l) => (
            <li key={l.label}>
              <a {...linkProps(l.to)} className="group rounded text-[var(--muted)] transition-colors hover:text-[var(--fg)]">
                <span className="u-line">{l.label} →</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
