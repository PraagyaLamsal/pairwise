import type { HubWindow } from '../windows/hub';
import { TutorSession } from './tutor';
import type { SessionDeps } from './controller';

export function createSession(deps: SessionDeps & { hub: HubWindow }): TutorSession {
  return new TutorSession(deps);
}

export type { TutorSession };
