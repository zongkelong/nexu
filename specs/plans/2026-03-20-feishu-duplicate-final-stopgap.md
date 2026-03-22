# Feishu Duplicate Final Stopgap

Date: 2026-03-20

## Context

We investigated a Feishu-local symptom where one inbound turn could produce two user-visible replies after tool usage.

Observed pattern:

- the first reply is a longer cumulative message
- the second reply is a shorter follow-up/tail message
- Feishu transport itself is not retrying the same payload

## Phase Findings

### 1. The duplication is not in Feishu transport

Runtime logs show one dispatcher instance delivering two distinct `final` replies in a single turn.

- `queuedFinal=true`
- `replies=2`
- the two final payloads have different text lengths and different previews

This means Feishu is faithfully delivering two upstream final payloads rather than retrying the same one.

### 2. The symptom shape is stable

Across multiple reproductions:

- the second final is emitted immediately after the first
- the second final is usually a shorter summary/tail of the longer first reply
- the issue is easiest to reproduce when the agent talks first, then calls tools

### 3. Root cause is likely above the Feishu dispatcher

The most likely source is OpenClaw reply orchestration rather than channel transport:

- duplicate final aggregation in reply pipeline
- followup/resume logic producing an additional final
- tool-resume path emitting a short tail final after a cumulative final

We attempted several compiled-runtime probe points. The most relevant live path for the Feishu plugin appears to be the plugin-sdk dispatch bundle, but the root-cause patch has not yet been completed.

## What Was Tried

### Runtime patch path

We validated a practical patching strategy for the locked OpenClaw runtime version:

- patch assets live under `openclaw-runtime-patches/`
- `apps/desktop/scripts/prepare-openclaw-sidecar.mjs` overlays those files onto `openclaw-runtime/node_modules/openclaw`
- the same patched files then flow into the desktop sidecar build

This strategy is confirmed working and is suitable for fast local verification.

### Feishu-layer instrumentation

Temporary Feishu-layer instrumentation was used during the investigation.

These logs were sufficient to confirm:

- single dispatcher instance
- multiple final deliveries
- lengths/previews for later final replies

### Content-based suppression experiments

We tried light-weight suppression based on:

- exact duplicate final text
- normalized whitespace containment
- tail-window containment

These did not reliably catch the duplicate because the later final is semantically overlapping but not always a strict substring of the earlier final.

## Current Stopgap

We landed a simple Feishu-side stopgap:

- within one Feishu reply dispatcher instance
- after the first text `final` is delivered
- later text `final` payloads are suppressed
- media can still pass through

This is intentionally simple and local. It is not a root-cause fix.

## Why This Stopgap Was Chosen

- user-visible duplication is the urgent problem
- the duplicate shape is stable enough to justify a local guard
- more complex text-similarity heuristics increased risk without becoming reliably stronger
- cross-turn or session-global suppression was intentionally avoided

## Current Assessment

The stopgap is good enough for local Feishu stabilization, but it has known limits:

- it is channel-local, not core-level
- it assumes one text final per dispatcher turn is the safe default
- it may hide a legitimate second final if upstream intentionally emits one in the future

## Recommended Next Step

Pursue a proper OpenClaw-core fix separately.

Most likely fix targets:

- reply aggregation before final dispatch
- followup drain / resume emission path
- tool-resume tail final handling

The Feishu stopgap can stay in place until the core path is understood and fixed.

## Patch Inventory

Relevant local patch files at the end of this phase:

- `openclaw-runtime-patches/openclaw/extensions/feishu/src/reply-dispatcher.ts`

Investigation-only debug patches outside this file were removed after the stopgap was validated.
