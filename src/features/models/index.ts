import type { Conversation } from '$features/conversation/types';

// ----- Model utilities -----

interface ModelTimelineEntry {
  date: Date;
  model: string;
}

// Default model timeline for null models — each entry is when that model became the default
const DEFAULT_MODEL_TIMELINE: ModelTimelineEntry[] = [
  { date: new Date('2024-01-01'), model: 'claude-3-sonnet-20240229' },
  { date: new Date('2024-06-20'), model: 'claude-3-5-sonnet-20240620' },
  { date: new Date('2024-10-22'), model: 'claude-3-5-sonnet-20241022' },
  { date: new Date('2025-02-24'), model: 'claude-3-7-sonnet-20250219' },
  { date: new Date('2025-05-22'), model: 'claude-sonnet-4-20250514' },
  { date: new Date('2025-09-29'), model: 'claude-sonnet-4-5-20250929' },
  { date: new Date('2026-02-17'), model: 'claude-sonnet-4-6' }
];

// Returns conversation.model if set; otherwise infers from created_at via the timeline
function inferModel(conversation: Conversation): string {
  if (conversation.model) {
    return conversation.model;
  }
  const conversationDate = new Date(conversation.created_at);
  for (let i = DEFAULT_MODEL_TIMELINE.length - 1; i >= 0; i--) {
    if (conversationDate >= DEFAULT_MODEL_TIMELINE[i].date) {
      return DEFAULT_MODEL_TIMELINE[i].model;
    }
  }
  return DEFAULT_MODEL_TIMELINE[0].model;
}

// Format a model ID like `claude-sonnet-4-5-20250929` into "Claude Sonnet 4.5".
// Schema reference: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
// Handles three documented shapes for the sonnet/opus/haiku families:
//   - Dateless 4.6+:        claude-{name}-{major}-{minor}            (canonical snapshot)
//   - Dated pre-4.6:        claude-{name}-{major}-{minor}-{YYYYMMDD}
//   - Convenience alias:    claude-{name}-{major}-{minor}            (resolves to most recent dated snapshot)
// Unknown families (anything not in `(sonnet|opus|haiku)`) fall through to raw display.
function formatModelName(model: string | null | undefined): string {
  if (!model || !model.startsWith('claude-')) {
    return model || 'Unknown';
  }

  // New format: claude-{type}-{major}[-{minor}][-{date}]
  const newFormatMatch = model.match(/^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (newFormatMatch) {
    const [, modelType, major, minor] = newFormatMatch;
    const modelName = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const version = minor ? `${major}.${minor}` : major;
    return `Claude ${modelName} ${version}`;
  }

  // Old format: claude-{major}[-{minor}]-{type}-{date}
  const oldFormatMatch = model.match(/^claude-(\d+)(?:-(\d+))?-(sonnet|opus|haiku)-\d{8}$/i);
  if (oldFormatMatch) {
    const [, major, minor, modelType] = oldFormatMatch;
    const modelName = modelType.charAt(0).toUpperCase() + modelType.slice(1);
    const version = minor ? `${major}.${minor}` : major;
    return `Claude ${modelName} ${version}`;
  }

  return model;
}

// Returns CSS badge class name based on the model family
function getModelBadgeClass(model: string | null | undefined): string {
  if (!model) return '';
  if (model.includes('sonnet')) return 'sonnet';
  if (model.includes('opus')) return 'opus';
  if (model.includes('haiku')) return 'haiku';
  return '';
}

export { DEFAULT_MODEL_TIMELINE, formatModelName, getModelBadgeClass, inferModel };
