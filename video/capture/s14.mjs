// Shot 14a: the airline agent's page, Live traffic — the shadow gateway's rows from a real request just made.
// Shot 14b (same script, --enforce): after the gateway was restarted in enforce mode and the request repeated.
import { record } from "./lib.mjs";

const which = process.argv.includes("--enforce") ? "b" : "a";

await record(`s14${which}-gateway`, async (s) => {
  await s.go("/app/agents/example-airline", 2500);
  await s.moveTo(400, 600, 300);
  await s.hold(600);
  // One instant jump before the shot starts, with the row mid-window so the zoom has room around it.
  const li = s.page.locator("li", { hasText: which === "a" ? "would block" : "blocked" }).first();
  await li.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await s.hold(1200);
  await s.mark("row", li);
  await s.hover(li, 900);
  await s.hold(3500);
  await s.mark("summary", s.page.locator("text=/\\d+ calls? · \\d+ (would block|blocked)/").first());
  await s.hold(2000);
});
