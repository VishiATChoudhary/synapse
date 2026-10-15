import React from "react";
import { Composition } from "remotion";
import { FINALE_FRAMES, MESH_FRAMES, Promo } from "./Promo";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Promo"
    component={Promo}
    durationInFrames={MESH_FRAMES + FINALE_FRAMES}
    fps={30}
    width={1920}
    height={1080}
  />
);
