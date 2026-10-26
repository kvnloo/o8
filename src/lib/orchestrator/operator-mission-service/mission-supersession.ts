import { findLaneByPacket } from '@/lib/lane/registry';
import {
  readMissionRegistryEntry,
  listMissionRegistryEntries,
  missionIsTerminal,
  persistMissionRegistryStateIfVersion,
  prepareMissionRegistrySupersession,
  withAtomicMissionRegistryBatch,
} from '@/lib/orchestrator/mission-registry';
import {
  readOrchestratorControlPlaneState,
  reconcileOrchestratorControlPlaneState,
  withControlPlaneLock,
  withLockedState,
  writeOrchestratorControlPlaneState,
} from '@/lib/orchestrator/control-plane';
import { recordOutgoingMissionSnapshot } from './mission-handoff';
import {
  listActiveMissionRegistryEntries,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

const SUPERSEDED_PACKET_REASON = 'superseded_by_newer_mission';

function packetBelongsToThread(packet: OrchestratorPacket, threadId: string): boolean {
  return packet.orchestratorThreadId?.trim() === threadId;
}

function packetIsInFlight(packet: OrchestratorPacket): boolean {
  return packet.status === 'launching'
    || packet.status === 'running'
    || packet.status === 'awaiting_review'
    || findLaneByPacket(packet.id) !== null;
}

export function cancelSupersededMissionPackets(
  state: OrchestratorMissionState,
  input: { threadId: string; successorMissionId: string; cancelledAt: string },
): boolean {
  const threadId = input.threadId.trim();
  if (!threadId || state.missionId === input.successorMissionId) return false;

  let changed = false;
  for (const packet of state.packets) {
    if (!packetBelongsToThread(packet, threadId)) continue;
    if (packet.archivedAt || packet.releaseState === 'released' || packet.status === 'failed') continue;
    if (packet.operatorStopped) continue;

    // Supersession policy: an in-flight packet keeps running and follows the
    // normal review path. Cancel only packets that have not launched, so the
    // successor cannot later open a second lane for the same thread's work.
    if (packetIsInFlight(packet)) continue;

    packet.operatorStopped = true;
    packet.queueState = 'held';
    packet.status = 'blocked';
    packet.blockedReason = SUPERSEDED_PACKET_REASON;
    packet.lastEventAt = input.cancelledAt;
    packet.lastEventLabel = SUPERSEDED_PACKET_REASON;
    packet.releaseStatePayload = {
      source: `mission_superseded:${input.successorMissionId}`,
    };
    changed = true;
  }
  return changed;
}

export async function cancelSupersededRegistryMissions(input: {
  threadId: string;
  successorMissionId: string;
  cancelledAt: string;
}): Promise<void> {
  for (const entry of listActiveMissionRegistryEntries(input.successorMissionId)) {
    if (!entry.mission.packets.some((packet) => packetBelongsToThread(packet, input.threadId))) {
      continue;
    }
    await withMissionRegistryState(entry.id, (state) => {
      cancelSupersededMissionPackets(state, input);
      return { state, result: undefined };
    });
  }
}

interface MissionCreationCommitInput {
  mission: OrchestratorMissionState;
  supersedingThreadId: string;
  supersededAt: string;
  assertAuthorized: () => void;
  bound: boolean;
  waitTimeoutMs: number;
  log: (message: string) => void;
}

/** Commit a bound supersession as one authorized SQLite/file handoff.
 * All awaited lock acquisition and registry discovery precede the final guard.
 * No packet is dispatched by this transaction.
 */
export async function persistCreatedMission(input: MissionCreationCommitInput): Promise<OrchestratorMissionState> {
  const { mission, supersedingThreadId, supersededAt, assertAuthorized, bound, waitTimeoutMs, log } = input;
  const missionId = mission.missionId!;
  if (bound && supersedingThreadId) {
    const cancellation = { threadId: supersedingThreadId, successorMissionId: missionId, cancelledAt: supersededAt };
    return withControlPlaneLock(async () => {
      assertAuthorized();
      const before = readOrchestratorControlPlaneState();
      const candidateIds = await prepareMissionRegistrySupersession(supersedingThreadId, missionId);
      assertAuthorized();
      const lockIds = [...candidateIds, ...(before.missionId ? [before.missionId] : [])];
      let replacedFile = false;
      try {
        return await withAtomicMissionRegistryBatch(lockIds, (persist) => {
          // This callback is entirely synchronous, including the file rename.
          // Revocation while either awaited lock is pending fails before writes.
          assertAuthorized();
          const current = readOrchestratorControlPlaneState();
          if (JSON.stringify(current) !== JSON.stringify(before)) {
            throw new Error('Control-plane mission changed during supersession lock acquisition.');
          }
          const active = listMissionRegistryEntries().filter((entry) => (
            entry.id !== missionId
            && !missionIsTerminal(entry.mission)
            && entry.mission.packets.some((packet) => packetBelongsToThread(packet, supersedingThreadId))
          ));
          if (active.some((entry) => !lockIds.includes(entry.id))) {
            throw new Error('Mission registry changed during supersession lock acquisition.');
          }
          for (const entry of active) {
            if (entry.id === current.missionId) continue;
            const next = structuredClone(entry.mission);
            if (cancelSupersededMissionPackets(next, cancellation)) persist(next);
          }
          if (current.missionId && current.missionId !== missionId) {
            const outgoing = structuredClone(current);
            cancelSupersededMissionPackets(outgoing, cancellation);
            if (readMissionRegistryEntry(current.missionId, { includeArchived: true })) {
              persist(outgoing, true);
            } else {
              recordOutgoingMissionSnapshot(outgoing);
            }
          }
          assertAuthorized();
          const written = writeOrchestratorControlPlaneState(reconcileOrchestratorControlPlaneState(mission));
          replacedFile = true;
          return written;
        });
      } catch (error) {
        // The registry transaction rolls back on error. If SQLite commit itself
        // fails after the file rename, restore the prior current snapshot.
        if (replacedFile) {
          try {
            writeOrchestratorControlPlaneState(before);
          } catch (restoreError) {
            throw new AggregateError([error, restoreError], 'Mission supersession recovery failed.');
          }
        }
        throw error;
      }
    }, { waitTimeoutMs });
  }

  // Existing legacy/unbound path is unchanged; authored admission alone
  // does not grant dispatch or modify non-supersession semantics.
    const { state, result: outgoing } = await withLockedState(
      async (current) => {
        assertAuthorized();
        if (supersedingThreadId) {
          cancelSupersededMissionPackets(current, {
            threadId: supersedingThreadId,
            successorMissionId: missionId,
            cancelledAt: supersededAt,
          });
          // Keep the current control-plane lock while older registry rows are
          // cancelled. A current or non-current dispatch must finish first and
          // count as in-flight, or observe the durable cancellation before it
          // can create a lane. This closes the switch-then-cancel launch gap.
          await cancelSupersededRegistryMissions({
            threadId: supersedingThreadId,
            successorMissionId: missionId,
            cancelledAt: supersededAt,
          });
        }
        // Replace the mission under the control-plane lock so a concurrent
        // headless tick cannot restore a stale mission after createMission returns.
        if (current.missionId && current.missionId !== missionId) {
          const registryEntry = readMissionRegistryEntry(current.missionId, { includeArchived: true });
          const snapshot = structuredClone(current);
          if (!registryEntry) {
            // The outgoing current file is authoritative even when an earlier
            // best-effort mission insert failed. Insert its exact snapshot
            // before swapping the file so its live packets remain addressable.
            // Any insert failure aborts the switch while the old current file
            // is still intact.
            recordOutgoingMissionSnapshot(snapshot);
          }
          Object.assign(current, mission);
          return registryEntry
            ? { mission: snapshot, registryVersion: registryEntry.updatedAt }
            : null;
        }
        Object.assign(current, mission);
        return null;
      },
      { waitTimeoutMs: waitTimeoutMs },
    );
    if (outgoing) {
      const persistedOutgoing = await persistMissionRegistryStateIfVersion(
        outgoing.mission,
        outgoing.registryVersion,
      );
      if (!persistedOutgoing) {
        log(`Outgoing mission ${outgoing.mission.missionId} advanced during mission switch; its newer registry state was preserved.`);
      }
    }
    return state;
}
