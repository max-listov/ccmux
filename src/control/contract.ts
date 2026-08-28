import { defineContract } from "stitchkit";
import { ExternalStatusSnapshotSchema, EXTERNAL_MAX_BYTES } from "../external/resident-schema.ts";
import {
  CONTROL_MAX_BYTES, ControlActionReceiptSchema, ControlInterruptSchema, ControlMessageReceiptSchema,
  ControlMessageSchema, ControlRowSchema, ControlSnapshotSchema, ControlTargetSchema,
  ControlWaitResultSchema, ControlWaitSchema,
} from "./schema.ts";

export const controlContract = defineContract({ prefix: "control", scope: "local" }, {
  list: { method: "GET", path: "/sessions", desc: "Read the prepared managed-session snapshot",
    toolName: "sessions", expose: ["HTTP", "CLI", "MCP"], output: ControlSnapshotSchema },
  external: { method: "GET", path: "/external", desc: "Read prepared external native thread states; does not adopt or start threads",
    toolName: "external", expose: ["HTTP", "CLI", "MCP"], output: ExternalStatusSnapshotSchema },
  get: { method: "POST", path: "/session", desc: "Read one exact managed session",
    toolName: "session", expose: ["HTTP", "CLI", "MCP"], idempotent: true,
    input: ControlTargetSchema, output: ControlRowSchema },
  message: { method: "POST", path: "/message", desc: "Accept an identity-pinned message into durable chat; acceptance is not completion",
    toolName: "message", expose: ["HTTP", "CLI", "MCP"], idempotent: true,
    input: ControlMessageSchema, output: ControlMessageReceiptSchema },
  start: { method: "POST", path: "/start", desc: "Start an existing registered session without changing its identity",
    toolName: "start", expose: ["HTTP", "CLI", "MCP"],
    input: ControlTargetSchema, output: ControlActionReceiptSchema },
  interrupt: { method: "POST", path: "/interrupt", desc: "Interrupt the exact active native turn; never answer an approval or input request",
    toolName: "interrupt", expose: ["HTTP", "CLI", "MCP"],
    input: ControlInterruptSchema, output: ControlActionReceiptSchema },
  wait: { method: "POST", path: "/wait", desc: "Wait for a native session between turns, including pending chat pickup",
    toolName: "wait", expose: ["HTTP", "CLI", "MCP"], idempotent: true,
    input: ControlWaitSchema, output: ControlWaitResultSchema },
});

export const controlEventsContract = defineContract({ prefix: "control-events", scope: "local" }, {
  watch: { method: "GET", path: "/", desc: "Subscribe to bounded absolute snapshots; reconnect establishes a fresh baseline",
    stream: { item: ControlSnapshotSchema, format: "ndjson", maxFrameBytes: CONTROL_MAX_BYTES + 1024, heartbeatMs: 2000 } },
  watchExternal: { method: "GET", path: "/external", desc: "Subscribe to prepared external native status, including unavailable and stale outcomes",
    stream: { item: ExternalStatusSnapshotSchema, format: "ndjson", maxFrameBytes: EXTERNAL_MAX_BYTES + 1024, heartbeatMs: 2000 } },
});
