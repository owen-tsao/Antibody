// Per-cycle chart for the Results list hover and the Cycle page. Vector SVG built from the records
// we already have, drawn at natural size so type stays crisp. It sits on an opaque --card panel
// (not under the list's mix-blend highlight), so greys are safe; the only non-grey is the danger
// outline on a rejected bar. No chart library.
//
// The markup is meant to be inlined into the document (not loaded through <img>), so its text can
// use the page's web font: an <img> SVG is a separate document and cannot see Inter.

import type { CycleRecord } from "@/api";
import { pct, regressionPct, rowStatus } from "@/lib/derive";

export const CHART_W = 300;
export const CHART_H = 260;
const PAD = { l: 14, r: 36, t: 52, b: 82 };

export interface ChartSize {
  w: number;
  h: number;
}

const FG = "#ededed";
const MUTED = "#8a8a8a";
const FAINT = "#5c5c5c";
const LINE = "#2a2a2a";
const DANGER = "#f87171";
const FONT = `font-family="Inter, system-ui, -apple-system, sans-serif"`;
const NUM = `${FONT} style="font-variant-numeric: tabular-nums"`;

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function versionsOf(c: CycleRecord) {
  return c.config_before === c.config_after ? `v${c.config_after}` : `v${c.config_before} → v${c.config_after}`;
}

/**
 * The chart markup (no data-URL wrapping) so it can be inlined. `size` sets the natural pixel
 * size; type stays the same size in either, so a wider chart gets more room, not bigger labels.
 */
export function cycleChartSvg(
  cycle: CycleRecord,
  all: CycleRecord[],
  legitSize: number,
  size: ChartSize = { w: CHART_W, h: CHART_H },
): string {
  const W = size.w;
  const H = size.h;
  const n = Math.max(1, all.length);
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const slot = plotW / n;
  const barW = Math.min(W > 400 ? 32 : 22, Math.max(8, slot * 0.46));
  const cx = (i: number) => PAD.l + slot * i + slot / 2;
  const y = (rate: number) => PAD.t + plotH - rate * plotH;
  const idx = Math.max(0, all.findIndex((c) => c.cycle === cycle.cycle));

  // Gridlines at 0 / 50 / 100 with labels on the right.
  const grid = [0, 0.5, 1]
    .map(
      (r) =>
        `<line x1="${PAD.l}" y1="${y(r)}" x2="${W - PAD.r}" y2="${y(r)}" stroke="${LINE}" stroke-width="1"/>` +
        `<text x="${W - PAD.r + 8}" y="${y(r) + 3.5}" ${NUM} font-size="10" fill="${FAINT}">${Math.round(r * 100)}</text>`,
    )
    .join("");

  // Hovered cycle: a soft band behind everything in its slot, tall enough to cover the x labels.
  const band = `<rect x="${PAD.l + slot * idx}" y="${PAD.t - 14}" width="${slot}" height="${plotH + 14 + 34}" rx="4" fill="#ffffff" opacity="0.06"/>`;

  // Bars: regression pass rate where a gate ran. Accepted bars filled, rejected bars outlined in
  // danger. Cycles with no gate (attack blocked) get a small tick on the baseline. The hovered bar
  // prints its value above itself so the reader does not have to eyeball the grid.
  // `chart-bar` / `chart-text` classes are hooks for the reveal animation (index.css .chart-animate),
  // staggered left to right; the classes do nothing unless the host panel opts in.
  const bars = all
    .map((c, i) => {
      const x0 = cx(i) - barW / 2;
      const here = i === idx;
      const delay = `style="animation-delay:${i * 45}ms"`;
      if (!c.gate) {
        return `<line class="chart-text" ${delay} x1="${x0}" y1="${y(0)}" x2="${x0 + barW}" y2="${y(0)}" stroke="${here ? FG : MUTED}" stroke-width="2"/>`;
      }
      const top = y(c.gate.regression_pass_rate);
      const h = Math.max(1.5, y(0) - top);
      const value = here
        ? `<text class="chart-text" x="${cx(i)}" y="${top - 5}" ${NUM} font-size="10" text-anchor="middle" fill="${c.gate.accepted ? FG : DANGER}">${Math.round(c.gate.regression_pass_rate * 100)}%</text>`
        : "";
      if (c.gate.accepted) {
        return `<rect class="chart-bar" ${delay} x="${x0}" y="${top}" width="${barW}" height="${h}" rx="2" fill="${FG}" opacity="${here ? 1 : 0.55}"/>${value}`;
      }
      return `<rect class="chart-bar" ${delay} x="${x0 + 0.5}" y="${top + 0.5}" width="${barW - 1}" height="${Math.max(1, h - 1)}" rx="2" fill="none" stroke="${DANGER}" stroke-width="1" opacity="${here ? 1 : 0.6}"/>${value}`;
    })
    .join("");

  // Legit pass rate, from the first gate onward (carried across later cycles without a gate).
  // Before any gate there is no measurement to plot, so the line starts there rather than at 100%.
  let rate: number | null = null;
  const pts: string[] = [];
  all.forEach((c, i) => {
    if (c.gate) rate = c.gate.legit_pass_rate;
    if (rate !== null) pts.push(`${cx(i)},${y(rate)}`);
  });
  const legit = pts.length ? `<polyline points="${pts.join(" ")}" fill="none" stroke="${MUTED}" stroke-width="1.25" stroke-dasharray="3 3"/>` : "";

  // Regression suite size: every failed attack adds a test, so the suite only grows. Drawn as a
  // faint step on its own scale (0..max), which reads as "the bar of tests each gate had to clear".
  const maxSuite = Math.max(1, ...all.map((c) => c.regression_suite_size));
  const sy = (size: number) => y(size / maxSuite);
  const steps: string[] = [];
  all.forEach((c, i) => {
    const yy = sy(c.regression_suite_size);
    steps.push(`${PAD.l + slot * i},${yy}`, `${PAD.l + slot * (i + 1)},${yy}`);
  });
  const suite = `<polyline points="${steps.join(" ")}" fill="none" stroke="${FAINT}" stroke-width="1" opacity="0.9"/>`;

  // X axis: cycle numbers, and under the cycles that changed the config, the version it produced.
  const xLabels = all
    .map((c, i) => {
      const num = `<text x="${cx(i)}" y="${y(0) + 15}" ${NUM} font-size="10" text-anchor="middle" fill="${i === idx ? FG : FAINT}">${c.cycle}</text>`;
      const bumped = c.gate?.accepted && c.config_after !== c.config_before;
      const ver = bumped
        ? `<text x="${cx(i)}" y="${y(0) + 27}" ${NUM} font-size="9" text-anchor="middle" fill="${i === idx ? MUTED : FAINT}">v${c.config_after}</text>`
        : "";
      return num + ver;
    })
    .join("");

  const status = rowStatus(cycle);
  const title = `cycle ${cycle.cycle} · ${versionsOf(cycle)} · ${status}`;
  const footer = cycle.gate
    ? `regression ${regressionPct(cycle)} · legit ${pct(cycle.gate.legit_pass_rate, legitSize)} · suite ${cycle.regression_suite_size}`
    : `attack blocked · no patch, no gate · suite ${cycle.regression_suite_size}`;

  const legendY = H - 12;
  const legend =
    `<rect x="${PAD.l}" y="${legendY - 7}" width="8" height="8" rx="1.5" fill="${FG}"/>` +
    `<text x="${PAD.l + 13}" y="${legendY}" ${FONT} font-size="10" fill="${MUTED}">accepted</text>` +
    `<rect x="${PAD.l + 68}" y="${legendY - 6.5}" width="7" height="7" rx="1.5" fill="none" stroke="${DANGER}"/>` +
    `<text x="${PAD.l + 80}" y="${legendY}" ${FONT} font-size="10" fill="${MUTED}">rejected</text>` +
    `<line x1="${PAD.l + 134}" y1="${legendY - 3.5}" x2="${PAD.l + 148}" y2="${legendY - 3.5}" stroke="${MUTED}" stroke-width="1.25" stroke-dasharray="3 3"/>` +
    `<text x="${PAD.l + 153}" y="${legendY}" ${FONT} font-size="10" fill="${MUTED}">legit</text>` +
    `<line x1="${PAD.l + 184}" y1="${legendY - 3.5}" x2="${PAD.l + 198}" y2="${legendY - 3.5}" stroke="${FAINT}" stroke-width="1"/>` +
    `<text x="${PAD.l + 203}" y="${legendY}" ${FONT} font-size="10" fill="${MUTED}">suite size</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">
  <text x="${PAD.l}" y="22" ${NUM} font-size="12.5" font-weight="500" fill="${FG}">${esc(title)}</text>
  <text x="${PAD.l}" y="37" ${FONT} font-size="10.5" fill="${MUTED}">gate pass rate per cycle</text>
  ${band}${grid}<g class="chart-lines">${suite}${legit}</g>${bars}<g class="chart-text">${xLabels}</g>
  <g class="chart-text"><text x="${PAD.l}" y="${y(0) + 46}" ${NUM} font-size="10.5" fill="${FG}">${esc(footer)}</text>
  ${legend}</g>
</svg>`;
}

export function cyclePreviewSvg(cycle: CycleRecord, all: CycleRecord[], legitSize: number): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(cycleChartSvg(cycle, all, legitSize))}`;
}
