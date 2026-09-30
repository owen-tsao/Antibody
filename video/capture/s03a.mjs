// Shot 3a: the home page, the airline agent's hero card. The cursor drifts onto the card; the composition zooms in.
import { record } from "./lib.mjs";

await record("s03a-home", async (s) => {
  await s.go("/app", 2600);
  await s.moveTo(1100, 780, 300);
  const card = s.page.locator("text=Agents SDK · running").first().locator("xpath=ancestor::div[3]");
  await s.mark("card", card);
  await s.hold(1200);
  await s.moveTo(560, 420, 1400);
  await s.hold(5000);
});
