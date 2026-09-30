// Shot 10: the Sep 22 run's results list. The cursor drifts down the twelve rows so the hover bar slides and each
// row's chart floats; it rests on #6, the one v0 → v1.
import { record } from "./lib.mjs";

await record("s10-run-hover", async (s) => {
  await s.go("/app/runs/20260925T233010Z", 2500);
  await s.moveTo(1180, 120, 300);
  await s.hold(1200);
  const rows = s.page.locator("text=/^#\\d+$/");
  const n = await rows.count();
  const order = [1, 2, 3, 4, 5];
  for (const i of order) {
    const row = s.page.locator(`text=/^#${i}$/`).first();
    await s.hover(row, 520);
    await s.hold(380);
  }
  const six = s.page.locator("text=/^#6$/").first();
  const c = await s.hover(six, 700);
  await s.mark("row6", six.locator("xpath=ancestor::tr[1]"));
  await s.hold(2600);
  for (const i of [7, 8, 9]) {
    await s.hover(s.page.locator(`text=/^#${i}$/`).first(), 420);
    await s.hold(260);
  }
  await s.hover(six, 800);
  await s.hold(2200);
  console.log(`rows found: ${n}; row6 at ${c.x},${c.y}`);
});
