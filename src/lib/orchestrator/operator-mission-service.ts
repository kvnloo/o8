import type { CreateMissionInput as MissionInput } from './operator-mission-service/types';
import type { AuthoredMissionInput } from './mission-intent-admission';
export type CreateMissionInput = MissionInput & AuthoredMissionInput;
export type {
  ApproveAndMergeInput,
  DispatchMissionInput,
  ExistingBranchPolicy,
  LoadedIssue,
  MergePacketResult,
  MissionStatusInput,
  PickComparisonWinnerInput,
  ResetPacketInput,
  SubmitReviewInput,
} from './operator-mission-service/types';

export {
  createMission,
  dispatchMission,
  getMissionStatus,
  MissionNotFoundError,
  resolveMissionDispatchTarget,
} from './operator-mission-service/mission';

export { prepareMissionDispatch } from './operator-mission-service/dispatch-admission';

export { submitPacketReview } from './operator-mission-service/review';

export {
  approveAndMergePacket,
  pickComparisonWinner,
} from './operator-mission-service/merge';

export { resetPacket } from './operator-mission-service/reset';

export { rerunWithFeedback } from './operator-mission-service/rerun-with-feedback';
export type { RerunWithFeedbackInput } from './operator-mission-service/rerun-with-feedback';

export { steerPacket } from './operator-mission-service/steer';
export type { SteerPacketInput, SteerPacketResult } from './operator-mission-service/steer';

export {
  buildInlineIssuesFromPrompt,
  resolveSpawnCount,
  assertSpawnBatchMaterializable,
} from './operator-mission-service/spawn-prompt';
