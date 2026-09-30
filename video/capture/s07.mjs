// Shot 7: press Heal on Current run for the airline agent (the saved defaults: 4 seeds, 2 chaos cycles, 1 repair
// attempt, vulnerability sweep on) and hold while the first orbs light. This starts a real run; everything after it
// in the video can come from the run it starts.
import { record } from "./lib.mjs";

await record("s07-heal", async (s) => {
  await s.go("/app/run", 2600);
  await s.moveTo(400, 760, 300);
  await s.hold(1400);
  const heal = s.page.getByRole("button", { name: /^heal$/i }).first();
  await s.mark("heal", heal);
  await s.click(heal, 1100);
  await s.hold(1200);
  await s.moveTo(1180, 800, 900);
  await s.hold(14000);
});
