import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { HookContext } from "./agent-tools.before-tool-call.types.js";
import type { AnyAgentTool } from "./tools/common.js";

export type BeforeToolCallDiagnosticOptions = {
  emitDiagnostics: boolean;
  protectNetworkErrors?: boolean;
  approvalMode?: "request" | "report" | "deny";
};

type BeforeToolCallMetadata = {
  options: BeforeToolCallDiagnosticOptions;
  sourceTool: AnyAgentTool;
  hookContext?: HookContext;
};

// Host metadata belongs to the wrapper, not the plugin object it exposes. Source-transformed
// SDK modules and compiled hosts share this map to recognize the same wrappers.
const metadataByTool = resolveGlobalSingleton(
  Symbol.for("openclaw.beforeToolCallMetadata"),
  () => new WeakMap<AnyAgentTool, BeforeToolCallMetadata>(),
);

export function bindBeforeToolCallMetadata(
  tool: AnyAgentTool,
  metadata: BeforeToolCallMetadata,
): void {
  metadataByTool.set(tool, metadata);
}

export function getBeforeToolCallSourceTool(tool: AnyAgentTool): AnyAgentTool | undefined {
  return metadataByTool.get(tool)?.sourceTool;
}

export function getBeforeToolCallHookContext(tool: AnyAgentTool): HookContext | undefined {
  return metadataByTool.get(tool)?.hookContext;
}

/** Return true when a tool already carries the before_tool_call wrapper state. */
export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  return metadataByTool.has(tool);
}

/** Toggle diagnostic event emission on an existing before_tool_call wrapper. */
export function setBeforeToolCallDiagnosticsEnabled(tool: AnyAgentTool, enabled: boolean): void {
  const options = metadataByTool.get(tool)?.options;
  if (options) {
    options.emitDiagnostics = enabled;
  }
}

export function getBeforeToolCallDiagnosticOptions(
  tool: AnyAgentTool,
): BeforeToolCallDiagnosticOptions | undefined {
  return metadataByTool.get(tool)?.options;
}

/** Preserve the exact options closed over by execution when another wrapper replaces a tool. */
export function copyBeforeToolCallMetadata(source: AnyAgentTool, target: AnyAgentTool): void {
  const metadata = metadataByTool.get(source);
  if (metadata) {
    metadataByTool.set(target, metadata);
  }
}
