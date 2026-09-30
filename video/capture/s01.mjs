// Shot 1: the landing hero, nine seconds, the liquid metal moving. No cursor.
import { record } from "./lib.mjs";

await record("s01-hero", async (s) => {
  await s.go("/", 1500);
  await s.moveTo(1439, 899, 100);
  await s.hold(9000);
});
