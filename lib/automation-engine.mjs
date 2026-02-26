import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const AUTOMATION_STATE_FILE = 'automation-state.json';

const WORKFLOW_TEMPLATES = [
  {
    id: 'viral_shorts_pipeline',
    name: 'Viral Shorts Pipeline',
    category: 'creator',
    tags: ['cuts', 'captions', 'cta', 'thumbnail'],
    nodes: [
      { id: 'trigger_ingest', type: 'TRIGGER', label: 'New video ingested' },
      { id: 'analyze_auto', type: 'ACTION', label: 'Auto analyze moments' },
      { id: 'cuts_auto', type: 'ACTION', label: 'Detect best cuts' },
      { id: 'captions_auto', type: 'ACTION', label: 'Generate captions' },
      { id: 'thumb_auto', type: 'ACTION', label: 'Generate thumb' },
      { id: 'publish_pack', type: 'ACTION', label: 'Publish pack' }
    ]
  },
  {
    id: 'ugc_ad_patch_flow',
    name: 'UGC Ad Frame Patch + Render',
    category: 'brand',
    tags: ['frame-edit', 'nano-banana', 'motion', 'incremental-render'],
    nodes: [
      { id: 'trigger_mark_frame', type: 'TRIGGER', label: 'Frame selected' },
      { id: 'patch_frame', type: 'ACTION', label: 'Patch region with AI' },
      { id: 'motion_rebuild', type: 'ACTION', label: 'Motion reconstruction' },
      { id: 'render_incremental', type: 'ACTION', label: 'Incremental render' },
      { id: 'qa_review', type: 'LOGIC', label: 'Manual QA gate' }
    ]
  },
  {
    id: 'agency_batch_ops',
    name: 'Agency Batch Ops',
    category: 'agency',
    tags: ['api', 'webhook', 'batch', 'marketplace'],
    nodes: [
      { id: 'trigger_webhook', type: 'TRIGGER', label: 'Webhook ingest' },
      { id: 'index_frames', type: 'ACTION', label: 'Frame indexing' },
      { id: 'template_apply', type: 'ACTION', label: 'Apply workflow template' },
      { id: 'render_multi', type: 'ACTION', label: 'Render 9:16 / 1:1 / 16:9' },
      { id: 'publish_api', type: 'ACTION', label: 'Publish to clients' }
    ]
  }
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function hashToUnit(seed) {
  const hash = createHash('sha1').update(String(seed || '')).digest();
  return hash[0] / 255;
}

function normalizeRegion(rawRegion) {
  const region = rawRegion && typeof rawRegion === 'object' ? rawRegion : {};
  const x = clamp(Number(region.x ?? 0.1), 0, 1);
  const y = clamp(Number(region.y ?? 0.1), 0, 1);
  const width = clamp(Number(region.width ?? 0.4), 0.01, 1);
  const height = clamp(Number(region.height ?? 0.4), 0.01, 1);
  return {
    x,
    y,
    width: Math.min(width, 1 - x),
    height: Math.min(height, 1 - y)
  };
}

function normalizeDuration(rawDuration) {
  const value = Number(rawDuration);
  if (!Number.isFinite(value) || value <= 0) return 60;
  return clamp(value, 1, 60 * 60 * 3);
}

function mergeRanges(inputRanges, paddingSec = 0) {
  const normalized = (Array.isArray(inputRanges) ? inputRanges : [])
    .map((range) => {
      const start = Number(range.start);
      const end = Number(range.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      const a = Math.min(start, end) - paddingSec;
      const b = Math.max(start, end) + paddingSec;
      return { start: Math.max(0, a), end: Math.max(0, b) };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  if (!normalized.length) return [];

  const merged = [normalized[0]];
  for (let i = 1; i < normalized.length; i += 1) {
    const current = normalized[i];
    const last = merged[merged.length - 1];
    if (current.start <= last.end + 0.001) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }

  return merged.map((range) => ({
    start: Number(range.start.toFixed(3)),
    end: Number(range.end.toFixed(3))
  }));
}

async function readJsonFile(path, fallback) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch (_error) {
    return fallback;
  }
}

async function writeJsonAtomic(path, payload) {
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  const tmpPath = `${path}.${Date.now()}.${Math.round(Math.random() * 10000)}.tmp`;
  await writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await rename(tmpPath, path);
}

function keywordCount(text, keywords) {
  if (!text) return 0;
  const lower = text.toLowerCase();
  return keywords.reduce((acc, keyword) => acc + (lower.includes(keyword) ? 1 : 0), 0);
}

function buildIngestSegments({ ingestId, durationSec, transcript }) {
  const segments = [];
  const chunk = clamp(Math.round(durationSec / 12), 2, 10);
  for (let start = 0; start < durationSec; start += chunk) {
    const end = Math.min(durationSec, start + chunk);
    const seed = `${ingestId}:${start.toFixed(2)}:${end.toFixed(2)}`;
    const energy = clamp(0.35 + hashToUnit(`${seed}:energy`) * 0.65, 0, 1);
    const emotion = ['neutral', 'excited', 'urgent', 'curious'][Math.floor(hashToUnit(`${seed}:emotion`) * 4)] || 'neutral';
    const speechDensity = clamp(0.2 + hashToUnit(`${seed}:speech`) * 0.8, 0, 1);
    const pauseScore = clamp(1 - speechDensity + hashToUnit(`${seed}:pause`) * 0.1, 0, 1);

    segments.push({
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      energy: Number(energy.toFixed(3)),
      emotion,
      speechDensity: Number(speechDensity.toFixed(3)),
      pauseScore: Number(pauseScore.toFixed(3))
    });
  }

  const ctaKeywords = ['agora', 'clique', 'link', 'compre', 'subscribe', 'inscreva', 'cta', 'action'];
  const viralKeywords = ['segredo', 'chocante', 'viral', 'erro', 'proibido', 'milhao', 'resultado'];
  const ctaWeight = keywordCount(transcript, ctaKeywords);
  const viralWeight = keywordCount(transcript, viralKeywords);

  const cuts = segments.map((segment, index) => ({
    id: `cut_${index + 1}`,
    start: segment.start,
    end: segment.end,
    score: Number((segment.energy * 0.55 + segment.speechDensity * 0.25 + (viralWeight > 0 ? 0.2 : 0.05)).toFixed(3))
  }));

  const viralMoments = segments
    .filter((segment) => segment.energy > 0.72 || segment.speechDensity > 0.8)
    .slice(0, 8)
    .map((segment, index) => ({
      id: `viral_${index + 1}`,
      start: segment.start,
      end: segment.end,
      score: Number((segment.energy * 0.6 + segment.speechDensity * 0.4 + Math.min(0.2, viralWeight * 0.03)).toFixed(3)),
      reason: segment.energy > 0.8 ? 'high_energy' : 'speech_punch'
    }));

  const faces = segments.slice(0, 6).map((segment, index) => ({
    id: `face_${index + 1}`,
    timestamp: Number((segment.start + (segment.end - segment.start) / 2).toFixed(2)),
    confidence: Number((0.65 + hashToUnit(`${ingestId}:face:${index}`) * 0.3).toFixed(3))
  }));

  const objects = ['microphone', 'phone', 'laptop', 'product', 'whiteboard']
    .map((name, index) => ({
      id: `obj_${index + 1}`,
      label: name,
      confidence: Number((0.55 + hashToUnit(`${ingestId}:obj:${name}`) * 0.4).toFixed(3))
    }));

  const screenText = transcript
    ? transcript.split(/\s+/).slice(0, 5).map((word, index) => ({
      id: `txt_${index + 1}`,
      text: word.replace(/[^\p{L}\p{N}_-]/gu, ''),
      timestamp: Number((index * (durationSec / 10)).toFixed(2)),
      confidence: Number((0.55 + hashToUnit(`${ingestId}:txt:${word}:${index}`) * 0.4).toFixed(3))
    })).filter((entry) => entry.text)
    : [];

  const ctaMoments = segments
    .filter((segment) => segment.energy > 0.6)
    .slice(-3)
    .map((segment, index) => ({
      id: `cta_${index + 1}`,
      start: segment.start,
      end: segment.end,
      confidence: Number((0.52 + segment.energy * 0.4 + Math.min(0.2, ctaWeight * 0.04)).toFixed(3))
    }));

  const indexing = {
    emotion: segments.map((segment) => ({ start: segment.start, end: segment.end, value: segment.emotion })),
    energy: segments.map((segment) => ({ start: segment.start, end: segment.end, value: segment.energy })),
    speech: segments.map((segment) => ({ start: segment.start, end: segment.end, value: segment.speechDensity })),
    pause: segments.map((segment) => ({ start: segment.start, end: segment.end, value: segment.pauseScore })),
    cta: ctaMoments
  };

  return {
    segments,
    detections: {
      cuts,
      faces,
      objects,
      screenText,
      viralMoments
    },
    indexing
  };
}

function buildFramePatchResult(input) {
  const patchId = String(input.patchId || randomUUID());
  const timestampSec = clamp(Number(input.timestampSec ?? input.frameTimestampSec ?? 0), 0, 60 * 60 * 3);
  const region = normalizeRegion(input.region);
  const instruction = String(input.instruction || input.prompt || '').trim();
  const provider = String(input.provider || 'google_nano_banana').trim().toLowerCase();
  const model = String(input.model || 'gemini-3-pro-image-preview').trim();
  const status = String(input.status || 'planned').trim() || 'planned';

  return {
    patchId,
    videoId: String(input.videoId || input.sourceId || 'session-video'),
    frame: {
      timestampSec: Number(timestampSec.toFixed(3)),
      frameIndex: Math.floor(timestampSec * clamp(Number(input.fps || 30), 12, 120)),
      fps: clamp(Number(input.fps || 30), 12, 120)
    },
    region,
    instruction,
    provider,
    model,
    status,
    assets: {
      frameOriginalUri: String(input.frameOriginalUri || ''),
      frameEditedUri: String(input.frameEditedUri || ''),
      diffVisualUri: String(input.diffVisualUri || '')
    },
    propagation: {
      method: String(input.motionMethod || 'optical_flow_reprojection'),
      windowSec: clamp(Number(input.propagationWindowSec || 0.6), 0.1, 3)
    },
    metadata: {
      createdAt: new Date().toISOString(),
      notes: String(input.notes || 'Patch layer criada. Worker de IA pode aplicar edição e atualizar diff visual.')
    }
  };
}

function buildMotionPlan(input) {
  const timestampSec = clamp(Number(input.timestampSec ?? 0), 0, 60 * 60 * 3);
  const method = String(input.method || input.motionMethod || 'optical_flow_reprojection').trim().toLowerCase();
  const radiusSec = clamp(Number(input.radiusSec || 0.6), 0.1, 3);

  return {
    motionJobId: randomUUID(),
    method,
    anchor: Number(timestampSec.toFixed(3)),
    window: {
      start: Number(Math.max(0, timestampSec - radiusSec).toFixed(3)),
      end: Number((timestampSec + radiusSec).toFixed(3))
    },
    stages: [
      { step: 'depth_estimation', engine: 'depth-anything-v2', status: 'queued' },
      { step: 'pose_tracking', engine: 'kling_pose', status: 'queued' },
      { step: 'optical_flow', engine: method === 'kling_3' ? 'kling_3.0' : 'raft', status: 'queued' },
      { step: 'temporal_blend', engine: 'motion_consistency', status: 'queued' }
    ],
    createdAt: new Date().toISOString()
  };
}

function framesToRanges(frames, fps) {
  const sorted = Array.from(new Set((Array.isArray(frames) ? frames : [])
    .map((frame) => Number(frame))
    .filter((frame) => Number.isFinite(frame) && frame >= 0)
    .map((frame) => Math.floor(frame))
  )).sort((a, b) => a - b);

  if (!sorted.length) return [];

  const ranges = [];
  let startFrame = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i < sorted.length; i += 1) {
    const current = sorted[i];
    if (current === prev + 1) {
      prev = current;
      continue;
    }
    ranges.push({ start: startFrame / fps, end: (prev + 1) / fps });
    startFrame = current;
    prev = current;
  }

  ranges.push({ start: startFrame / fps, end: (prev + 1) / fps });
  return ranges;
}

function invertRanges(durationSec, changedRanges) {
  const ranges = [];
  let cursor = 0;
  changedRanges.forEach((range) => {
    if (range.start > cursor) {
      ranges.push({ start: Number(cursor.toFixed(3)), end: Number(range.start.toFixed(3)) });
    }
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < durationSec) {
    ranges.push({ start: Number(cursor.toFixed(3)), end: Number(durationSec.toFixed(3)) });
  }
  return ranges;
}

function buildIncrementalRenderPlan(payload) {
  const durationSec = normalizeDuration(payload.durationSec || payload.videoDurationSec || 60);
  const fps = clamp(Number(payload.fps || 30), 12, 120);

  const patchRanges = (Array.isArray(payload.patchLayers) ? payload.patchLayers : [])
    .map((patch) => {
      const ts = Number(patch?.frame?.timestampSec ?? patch?.timestampSec);
      if (!Number.isFinite(ts)) return null;
      const radius = clamp(Number(patch?.propagation?.windowSec || 0.55), 0.1, 3);
      return { start: Math.max(0, ts - radius), end: Math.min(durationSec, ts + radius) };
    })
    .filter(Boolean);

  const explicitRanges = (Array.isArray(payload.changedRanges) ? payload.changedRanges : [])
    .map((range) => ({ start: Number(range.start), end: Number(range.end) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end));

  const explicitFrameRanges = framesToRanges(payload.changedFrames || [], fps);

  const changedRanges = mergeRanges([...patchRanges, ...explicitRanges, ...explicitFrameRanges], 0.04)
    .map((range) => ({
      start: Number(clamp(range.start, 0, durationSec).toFixed(3)),
      end: Number(clamp(range.end, 0, durationSec).toFixed(3))
    }))
    .filter((range) => range.end - range.start > 0.01);

  const unchangedRanges = invertRanges(durationSec, changedRanges);

  const segments = [
    ...changedRanges.map((range) => ({ ...range, mode: 'reencode' })),
    ...unchangedRanges.map((range) => ({ ...range, mode: 'copy' }))
  ].sort((a, b) => a.start - b.start);

  const renderProfiles = Array.isArray(payload.outputProfiles) && payload.outputProfiles.length
    ? payload.outputProfiles
    : ['9:16', '1:1', '16:9'];

  return {
    renderPlanId: randomUUID(),
    durationSec: Number(durationSec.toFixed(3)),
    fps,
    changedRanges,
    unchangedRanges,
    segments,
    renderProfiles,
    preserve: {
      audio: true,
      captions: true,
      cuts: true,
      compressionConsistency: true
    },
    cacheHints: {
      keyframeStride: Math.round(fps * 2),
      reencodeRatio: Number((changedRanges.reduce((acc, range) => acc + (range.end - range.start), 0) / durationSec).toFixed(4))
    },
    createdAt: new Date().toISOString()
  };
}

export function createAutomationEngine({ dataRoot }) {
  const statePath = join(dataRoot, 'automation', AUTOMATION_STATE_FILE);

  async function readState() {
    const fallback = {
      version: 1,
      ingestRuns: [],
      patchLayers: [],
      motionJobs: [],
      renderPlans: [],
      appliedWorkflows: []
    };
    return readJsonFile(statePath, fallback);
  }

  async function writeState(nextState) {
    await writeJsonAtomic(statePath, nextState);
  }

  async function runIngestAnalysis(payload) {
    const source = payload && typeof payload.source === 'object' ? payload.source : {};
    const durationSec = normalizeDuration(payload.durationSec || payload.duration || source.durationSec || 60);
    const transcript = String(payload.transcript || payload.transcriptText || '').trim();
    const ingestId = randomUUID();

    const { segments, detections, indexing } = buildIngestSegments({ ingestId, durationSec, transcript });

    const analysis = {
      ingestId,
      createdAt: new Date().toISOString(),
      source: {
        kind: String(source.kind || payload.sourceKind || 'manual').trim(),
        url: String(source.url || payload.sourceUrl || '').trim() || null,
        label: String(source.label || payload.sourceLabel || '').trim() || null
      },
      durationSec,
      detections,
      indexing,
      stats: {
        segments: segments.length,
        cuts: detections.cuts.length,
        viralMoments: detections.viralMoments.length,
        ctaMoments: indexing.cta.length
      }
    };

    const state = await readState();
    state.ingestRuns.unshift(analysis);
    state.ingestRuns = state.ingestRuns.slice(0, 50);
    await writeState(state);

    return analysis;
  }

  async function createFramePatch(payload) {
    const patch = buildFramePatchResult(payload || {});
    const state = await readState();
    const existingIndex = state.patchLayers.findIndex((item) => String(item.patchId || '') === patch.patchId);
    if (existingIndex >= 0) state.patchLayers[existingIndex] = patch;
    else state.patchLayers.unshift(patch);
    state.patchLayers = state.patchLayers.slice(0, 300);
    await writeState(state);
    return patch;
  }

  async function createMotionReconstruction(payload) {
    const plan = buildMotionPlan(payload || {});
    const state = await readState();
    state.motionJobs.unshift(plan);
    state.motionJobs = state.motionJobs.slice(0, 300);
    await writeState(state);
    return plan;
  }

  async function createIncrementalRender(payload) {
    const plan = buildIncrementalRenderPlan(payload || {});
    const state = await readState();
    state.renderPlans.unshift(plan);
    state.renderPlans = state.renderPlans.slice(0, 300);
    await writeState(state);
    return plan;
  }

  async function listTemplates() {
    return WORKFLOW_TEMPLATES;
  }

  async function applyTemplate(payload) {
    const templateId = String(payload.templateId || '').trim();
    const template = WORKFLOW_TEMPLATES.find((item) => item.id === templateId);
    if (!template) {
      const error = new Error('templateId inválido.');
      error.statusCode = 400;
      throw error;
    }

    const workflowName = String(payload.workflowName || template.name).trim() || template.name;
    const delays = payload.delays && typeof payload.delays === 'object' ? payload.delays : {};
    const nodeOverrides = payload.nodeOverrides && typeof payload.nodeOverrides === 'object' ? payload.nodeOverrides : {};

    const workflow = {
      workflowId: randomUUID(),
      templateId: template.id,
      workflowName,
      createdAt: new Date().toISOString(),
      nodes: template.nodes.map((node, index) => {
        const override = nodeOverrides[node.id] || {};
        return {
          id: node.id,
          type: node.type,
          label: String(override.label || node.label),
          order: index + 1,
          delayMinutes: clamp(Number(delays[node.id] ?? override.delayMinutes ?? (node.type === 'LOGIC' ? 10 : 2)), 0, 1440),
          config: {
            ...override.config
          }
        };
      })
    };

    const state = await readState();
    state.appliedWorkflows.unshift(workflow);
    state.appliedWorkflows = state.appliedWorkflows.slice(0, 200);
    await writeState(state);

    return workflow;
  }

  async function getStateSnapshot() {
    const state = await readState();
    return {
      ingestRuns: state.ingestRuns.slice(0, 10),
      patchLayers: state.patchLayers.slice(0, 30),
      motionJobs: state.motionJobs.slice(0, 30),
      renderPlans: state.renderPlans.slice(0, 30),
      appliedWorkflows: state.appliedWorkflows.slice(0, 20)
    };
  }

  return {
    runIngestAnalysis,
    createFramePatch,
    createMotionReconstruction,
    createIncrementalRender,
    listTemplates,
    applyTemplate,
    getStateSnapshot
  };
}

export {
  mergeRanges,
  buildIncrementalRenderPlan
};
