import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { runCommandBuffered } from "../process/exec.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "./disk-space.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir.js";
import { measureUpdateStateFiles, withUpdateCandidateIoBudget } from "./update-candidate-io.js";
import {
  collectStateDatabasePaths,
  UpdateCandidateStateInventorySchema,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";

type SnapshotSize = { bytes: number; largest: number };

function requiredSnapshotBytes(size: SnapshotSize): number {
  // Keep the completed generation and Doctor backup, plus the largest raw,
  // compacting and publication copies. Metadata needs room on an empty state too.
  return size.bytes * 2 + size.largest * 3 + 64 * 1024 * 1024;
}

function chooseSnapshotRoot(stateDir: string, size: SnapshotSize): string {
  const required = requiredSnapshotBytes(size);
  const roots = [os.tmpdir(), path.resolve(stateDir, "tmp")];
  const available = roots.map((root) => tryReadDiskSpace(root));
  const index = available.findIndex((space) => !space || space.availableBytes >= required);
  if (index >= 0) {
    return roots[index]!;
  }
  throw new Error(
    `Update state snapshot requires ${formatDiskSpaceBytes(required)} for ${formatDiskSpaceBytes(size.bytes)} of SQLite state and scratch space; ${roots.map((root, i) => `${root}: ${formatDiskSpaceBytes(available[i]!.availableBytes)} available`).join("; ")}. Free space on either filesystem before retrying.`,
  );
}

async function allocateSnapshotRoot(root: string, stateDir: string): Promise<string> {
  const directory =
    root === path.resolve(stateDir, "tmp")
      ? resolvePreferredOpenClawTmpDir({
          preferredDir: path.join(root, "openclaw"),
          tmpdir: () => root,
        })
      : root;
  return fs.realpath(await fs.mkdtemp(path.join(directory, "openclaw-update-canary-")));
}

/** The parent owns both the child and its scratch root, including a killed SQLite operation. */
export async function prepareUpdateCandidateStateSnapshot(params: {
  config: OpenClawConfig;
  candidateRoot: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  workerEnv: (directory: string) => NodeJS.ProcessEnv;
  nodeRunner?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ stateDir: string; pluginPaths: Record<string, string> }> {
  const initialFiles = await collectStateDatabasePaths(params);
  let size = await measureUpdateStateFiles(
    [...initialFiles.values()].map(({ spellings }) => spellings[0]),
  );
  let selectedRoot = chooseSnapshotRoot(params.stateDir, size);
  let directory = await allocateSnapshotRoot(selectedRoot, params.stateDir);
  const run = async (mode: "inventory" | "snapshot") => {
    return await withUpdateCandidateIoBudget(
      {
        directory,
        bytes: size.bytes,
        timeoutMs: params.timeoutMs,
        signal: params.signal,
        operation: "snapshot",
      },
      async (signal) => {
        const result = await runCommandBuffered(
          [
            params.nodeRunner ?? process.execPath,
            ...resolveRuntimeWorkerArgv(
              resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
              params.nodeRunner,
            ),
          ],
          {
            input: JSON.stringify({
              mode,
              stateDir: params.stateDir,
              config: params.config,
              targetStateDir: directory,
              candidateRoot: params.candidateRoot,
              env: {
                HOME: params.env.HOME,
                OPENCLAW_HOME: params.env.OPENCLAW_HOME,
                USERPROFILE: params.env.USERPROFILE,
                OPENCLAW_AGENT_DIR: params.env.OPENCLAW_AGENT_DIR,
                PI_CODING_AGENT_DIR: params.env.PI_CODING_AGENT_DIR,
                OPENCLAW_BUNDLED_PLUGINS_DIR: params.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
                OPENCLAW_DISABLE_BUNDLED_PLUGINS: params.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
              },
            }),
            baseEnv: params.workerEnv(directory),
            signal,
            killGraceMs: 500,
            maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
          },
        );
        signal.throwIfAborted();
        if (result.code !== 0) {
          throw new Error(
            `Update state snapshot failed (${result.termination}): ${redactSupportString(result.stderr.toString("utf8"), { env: params.env, stateDir: params.stateDir }, { maxLength: 20_000 })}`,
          );
        }
        return JSON.parse(result.stdout.toString("utf8")) as unknown;
      },
    );
  };
  try {
    const shared = path.resolve(params.stateDir, "state", "openclaw.sqlite");
    if (
      await fs.stat(shared).then(
        () => true,
        (error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return false;
          }
          throw error;
        },
      )
    ) {
      const files = UpdateCandidateStateInventorySchema.parse(await run("inventory"));
      size = await measureUpdateStateFiles(
        [...files.values()].map(({ spellings }) => spellings[0]),
      );
      const fullSetRoot = chooseSnapshotRoot(params.stateDir, size);
      if (fullSetRoot !== selectedRoot) {
        await fs.rm(directory, { recursive: true, force: true });
        selectedRoot = fullSetRoot;
        directory = await allocateSnapshotRoot(selectedRoot, params.stateDir);
      }
    }
    const { pluginPaths } = UpdateCandidateStateSnapshotSchema.parse(await run("snapshot"));
    return { stateDir: directory, pluginPaths };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
