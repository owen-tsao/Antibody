// Shot 13, two beats in one take. (a) Reading: the Sep 22 run's v1 in the editor — a real three-line tool_rules diff
// with the gate's numbers in the header. (b) Deciding: back to the inbox, the live run's pending Fix 1, Approve.
// A real approval: runs/approvals.json changes.
import { record } from "./lib.mjs";

await record("s13-review", async (s) => {
  await s.go("/app/review/20260925T233010Z/1", 2600);
  await s.moveTo(1100, 400, 300);
  await s.hold(400);
  const diff = s.page.locator("text=issue_compensation: needs lookup").first();
  await s.mark("diff", diff.locator("xpath=ancestor::div[2]"));
  await s.mark("header", s.page.locator("text=blocked 2/2 tries").first());
  await s.hover(s.page.locator("text=book_new_flight: needs lookup").first(), 1000);
  await s.hold(3200);
  // (b)
  await s.click(s.page.getByRole("link", { name: /^review$/i }).first(), 800);
  await s.hold(2000);
  const card = s.page.locator("text=Fix 1").first();
  await s.mark("card", card.locator("xpath=ancestor::div[3]"));
  await s.hover(s.page.locator("text=fixes cycle 3").first(), 900);
  await s.hold(1800);
  const approve = s.page.getByRole("button", { name: /^approve$/i }).first();
  await s.mark("approve", approve);
  await s.click(approve, 1000);
  await s.hold(3600);
});
