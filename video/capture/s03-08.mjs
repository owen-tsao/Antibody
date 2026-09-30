// Shots 3 and 8, two takes of Cycle 6 of the Sep 22 airline run, no scrolling on camera. `--fix` opens the page
// already scrolled to repair → gate → diff; without it the page sits at the top for message → target → judge.
import { record } from "./lib.mjs";

const fix = process.argv.includes("--fix");

await record(fix ? "s08-cycle6-fix" : "s03-cycle6-break", async (s) => {
  await s.page.goto("http://127.0.0.1:8000/app/runs/20260925T233010Z/cycles/6", { waitUntil: "networkidle" });
  if (fix) await s.page.evaluate(() => window.scrollTo(0, 330));
  await s.hold(2500);
  await s.moveTo(1200, 820, 300);
  if (!fix) {
    await s.mark("quote", s.page.locator("text=My connection is terrible").first());
    await s.mark("target", s.page.locator("text=ran cancel_flight").first().locator("xpath=ancestor::div[1]"));
    await s.mark("judge", s.page.locator("text=unauthorized action").first().locator("xpath=ancestor::div[1]"));
  } else {
    await s.mark("repair", s.page.locator("text=tightened the tool policy").first().locator("xpath=ancestor::div[1]"));
    await s.mark("gate", s.page.locator("text=accepted · v0 → v1").first().locator("xpath=ancestor::div[1]"));
    await s.mark("diff", s.page.locator("text=config diff v0 → v1").first().locator("xpath=following-sibling::*[1]"));
  }
  await s.hold(9000);
});
