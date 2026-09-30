// Shot 15a: the built-in demo agent's 22-cycle run — the loop run until the attacker runs dry: v0 → v4, later attacks
// simply "blocked". The cursor rests on the first fix, then drifts down the rows that are on screen.
import { record } from "./lib.mjs";

await record("s15a-donut", async (s) => {
  await s.go("/app/runs/20260930T032937Z", 2500);
  await s.moveTo(1180, 120, 300);
  await s.hold(800);
  const five = s.page.locator("text=/^#5$/").first();
  await s.hover(five, 700);
  await s.mark("row5", five.locator("xpath=ancestor::tr[1]"));
  await s.hold(1800);
  for (const i of [7, 9, 11]) {
    const row = s.page.locator(`text=/^#${i}$/`).first();
    if (await row.isVisible()) await s.hover(row, 500);
    await s.hold(300);
  }
  await s.hold(2400);
});
