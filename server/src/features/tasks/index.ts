/** Task stub (Wave 1): the gate is off and the board is empty. W4 (tasks-and-messages) replaces this. */
import type { FeatureFactory } from '../../../../shared/contracts';

export const createTasks: FeatureFactory<'tasks'> = () => ({
  gate: () => ({ allow: true }),
  inProgressFor: () => null,
  onAgentEnded: () => {},
  list: () => [],
});
