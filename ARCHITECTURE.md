# SYSTEM ARCHITECTURE

## Backend stack (Node / Python)
- `Node.js` API gateway (`server.mjs`) for auth, orchestration, key vault, workflow routing, render planning, and provider failover.
- `Python` worker tier (recommended) for heavy video/vision tasks (`ffmpeg`, `opencv`, optical flow, depth, pose tracking).
- Runtime split:
- control plane in Node (fast APIs, workflows, state)
- compute plane in Python workers (queue-based jobs)

## Video processing engine
- Canonical media representation:
- source video + immutable audio track
- frame index cache (fps, timestamps, keyframes)
- patch layers (frame delta instructions)
- Segment graph:
- `raw segments`
- `edited segments`
- `render segments` (copy vs reencode)

## AI processing orchestration
- Provider adapters:
- Google Nano Banana (`gemini-3-pro-image-preview`) for frame-region edits
- Kling/Veo adapters for motion continuation
- ElevenLabs adapter for speech-to-text + timestamps
- Orchestration states:
- `queued` -> `processing` -> `qa_ready` -> `published`
- Fallback chain:
- provider rate-limit -> provider backup -> cached result -> manual approval

## Caching system
- Cache keys include:
- source hash, frame index, patch hash, model version, provider params
- Multi-layer cache:
- metadata cache
- frame extraction cache
- patch result cache
- render segment cache

## Frame indexing strategy
- Build frame/time map once per source (`timestamp -> frameIndex`, `frameIndex -> timestamp`).
- Derive feature index:
- cut boundaries
- speech density
- pause windows
- emotion/energy scores
- CTA windows

## Render engine strategy
- Differential render planner computes changed ranges only.
- Unchanged ranges use stream-copy whenever codec/profile constraints allow.
- Changed ranges are re-encoded and stitched preserving:
- original audio continuity
- caption timeline sync
- cut boundaries

---

# FRAME EDITING PIPELINE

1. Extract frame by timestamp (`ffmpeg -ss ts -frames:v 1`).
2. User draws ROI (box/lasso) on canvas.
3. Crop ROI and send only masked region + prompt to Google Nano Banana.
4. Receive edited patch.
5. Composite patch on original frame.
6. Generate visual diff (`absdiff` heatmap or alpha overlay).
7. Run motion continuity:
- Kling 3.0 interpolation OR
- optical flow reprojection + temporal blend
8. Reinsert edited frame window into timeline.
9. Plan incremental render for changed ranges.

## Pseudocode: frame extraction
```js
function extractFrame(videoPath, timestampSec, outPng) {
  exec(`ffmpeg -ss ${timestampSec} -i ${videoPath} -frames:v 1 ${outPng}`);
  return outPng;
}
```

## Pseudocode: frame replacement
```js
function replaceFrame(baseFrame, editedPatch, region) {
  const composed = clone(baseFrame);
  composed.blit(editedPatch, region.x, region.y, region.w, region.h);
  return composed;
}
```

## Pseudocode: motion interpolation
```js
function reconstructMotion(frames, anchorIdx, method) {
  if (method === 'kling_3') return klingInterpolate(frames, anchorIdx);
  const flowFw = calcOpticalFlow(frames[anchorIdx - 1], frames[anchorIdx]);
  const flowBw = calcOpticalFlow(frames[anchorIdx], frames[anchorIdx + 1]);
  return temporalBlend(frames, flowFw, flowBw, anchorIdx);
}
```

## Pseudocode: incremental render
```js
function incrementalRender(duration, changedRanges, profiles) {
  const merged = mergeRanges(changedRanges, 0.04);
  const untouched = invertRanges(duration, merged);
  const plan = [
    ...merged.map(r => ({ ...r, mode: 'reencode' })),
    ...untouched.map(r => ({ ...r, mode: 'copy' }))
  ].sort((a,b)=>a.start-b.start);
  return executeRenderPlan(plan, profiles, { preserveAudio: true });
}
```

---

# API KEY MANAGEMENT

## Security
- Keys encrypted at rest with AES-256-GCM.
- Master key from environment (`KEY_VAULT_MASTER_KEY`).
- Never expose plaintext keys to frontend after save.

## Rate limiting
- Per-provider windows (e.g., requests/min).
- On quota exceed: return `429` + `retryAt`.

## Failover
- Provider key resolution order:
- request key -> env key -> vault key
- Adapter fallback order configurable by workflow node.

## Cost tracking
- Usage ledger per provider:
- request count
- estimated cost USD
- last used timestamp

---

# DRAG AND DROP EDITOR

## Layer system
- Ordered layers:
- background
- subject
- overlay
- captions
- motion patch
- Each layer supports visible/locked/versioned flags.

## Frame locking
- Patch layers can lock anchor frame and propagation window.

## Region selection
- ROI stored as normalized coordinates (`0..1`) to survive resolution changes.

## Timeline sync
- Any patch updates timeline ranges and render diff map.
- Captions/CTA markers remain aligned by timestamp map.

---

# DIFFERENTIAL RENDERING ENGINE

## Change detection
- Sources of change:
- frame patches
- overlay edits
- caption timing edits
- crop/transform edits

## Selective re-render
- Merge all deltas into minimal changed ranges.
- Re-render only changed ranges + small overlap padding.

## Preserve audio
- Original audio remains primary track.
- Optional music/effects mixed non-destructively.

## Compression consistency
- Keep target GOP/profile constant.
- Use stitch strategy that minimizes visible transition artifacts at segment boundaries.

---

# PRODUCTION SCALE NOTES
- Queue system: Redis + worker autoscaling.
- Artifacts: object storage with versioned URIs.
- Observability: traces per workflow node + per-provider latency/cost.
- Marketplace: signed workflow manifests + template versioning + permission scopes.
