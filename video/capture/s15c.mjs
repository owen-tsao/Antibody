// Shot 15c: the Schedules orbit, then the New schedule dialog with `every 6 h` and `on change` visible. Nothing saved.
import { record } from "./lib.mjs";

await record("s15c-schedules", async (s) => {
  await s.go("/app/schedules", 2500);
  await s.moveTo(1100, 760, 300);
  await s.hold(2600);
  const btn = s.page.getByRole("button", { name: /new schedule|add schedule|schedule/i }).first();
  if (await btn.count()) {
    await s.click(btn, 800);
    await s.hold(900);
    const dialog = s.page.getByRole("dialog");
    await s.mark("dialog", dialog);
    const six = dialog.locator("text=every 6 h").first();
    if (await six.count()) {
      await s.hover(six, 700);
      await s.hold(900);
    }
    const onChange = dialog.locator("text=/whenever|on change|tools change/i").first();
    if (await onChange.count()) {
      await s.hover(onChange, 700);
      await s.hold(1400);
    }
  } else {
    await s.hold(2000);
  }
});
