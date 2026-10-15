import React from "react";
import { Composition } from "remotion";
import { FINALE_FRAMES, MESH_FRAMES, Promo } from "./Promo";
import { CINEMATIC_FRAMES, Cinematic } from "./Cinematic";
import { TWITTER_FRAMES, Twitter } from "./Twitter";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="Promo" component={Promo} durationInFrames={MESH_FRAMES + FINALE_FRAMES} fps={30} width={1920} height={1080} />
    <Composition id="Twitter" component={Twitter} durationInFrames={TWITTER_FRAMES} fps={30} width={1080} height={1080} />
    <Composition id="Cinematic" component={Cinematic} durationInFrames={CINEMATIC_FRAMES} fps={30} width={1920} height={1080} />
  </>
);
