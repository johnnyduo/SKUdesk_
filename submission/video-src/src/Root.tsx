import { Composition } from 'remotion';
import { Demo } from './Demo';
import timing from './timing.json';
export const FPS = 30;
export const Root: React.FC = () => (
  <Composition id="Demo" component={Demo} durationInFrames={Math.round(timing.total * FPS)} fps={FPS} width={1440} height={900} />
);
