import React from "react";
import { registerRoot, Composition, Sequence, AbsoluteFill, Audio, staticFile, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { SHOTS, FPS, FADE, MUSIC, TOTAL, startOf } from "./shots";
import { Statement, Metric, Logo, UI, Terminal, useFadeIn } from "./components";

const Fade: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const o = useFadeIn(FADE);
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

const Music: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  if (!MUSIC) return null;
  const t = frame / fps;
  const end = durationInFrames / fps;
  // −14 dB ≈ 0.2 amplitude; in over the hero, out over the logo.
  const vol = interpolate(t, [0, 4, end - 4, end], [0, 0.2, 0.2, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return <Audio src={staticFile(MUSIC)} volume={vol} />;
};

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: "#000" }}>
    {SHOTS.map((shot, i) => {
      const from = Math.round(startOf(i) * FPS);
      // Each shot outlives its slot by the fade so the next one dissolves over it.
      const frames = Math.round(shot.dur * FPS) + Math.round(FADE * FPS);
      return (
        <Sequence key={shot.id} from={from} durationInFrames={frames} name={shot.id}>
          <Fade>
            {shot.type === "statement" && <Statement shot={shot} />}
            {shot.type === "metric" && <Metric shot={shot} />}
            {shot.type === "logo" && <Logo shot={shot} />}
            {shot.type === "terminal" && <Terminal shot={shot} />}
            {shot.type === "ui" && <UI shot={shot} />}
          </Fade>
        </Sequence>
      );
    })}
    <Music />
  </AbsoluteFill>
);

const Root: React.FC = () => (
  <Composition id="Demo" component={Demo} durationInFrames={Math.round(TOTAL * FPS)} fps={FPS} width={1920} height={1080} />
);

registerRoot(Root);
