import type { Conversation } from '$features/conversation/types';

// ----- Model utilities -----

// The model families claude.ai serves. Both `formatModelName` regexes and
// `getModelBadgeClass` are built from this one list, so adding a family is a
// single edit — the previous hardcoded `(sonnet|opus|haiku)` appeared in three
// places and a new family silently fell through to a raw ID in the UI.
// `fable` and `mythos` are here ahead of general availability: an unrecognised
// family costs a broken-looking Model column, and recognising one that never
// ships costs nothing.
const MODEL_FAMILIES = ['sonnet', 'opus', 'haiku', 'fable', 'mythos'] as const;

const FAMILY_ALTERNATION = MODEL_FAMILIES.join('|');

const capitalise = (word: string): string =>
  word.charAt(0).toUpperCase() + word.slice(1);

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
  { date: new Date('2026-02-17'), model: 'claude-sonnet-4-6' },
];

// Returns conversation.model if set; otherwise infers from created_at via the timeline
const inferModel = (conversation: Conversation): string => {
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
};

// Format a model ID like `claude-sonnet-4-5-20250929` into "Claude Sonnet 4.5".
// Schema reference: https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions
// Handles four documented shapes:
//   - Dateless 4.6+:        claude-{name}-{major}[-{minor}]          (canonical snapshot)
//   - Dated pre-4.6:        claude-{name}-{major}-{minor}-{YYYYMMDD}
//   - Convenience alias:    claude-{name}-{major}-{minor}            (resolves to most recent dated snapshot)
//   - Named channel:        claude-{name}-preview                    (e.g. claude-mythos-preview)
// Unknown families (anything not in MODEL_FAMILIES) fall through to raw display.
const formatModelName = (model: string | null | undefined): string => {
  if (!model || !model.startsWith('claude-')) {
    return model || 'Unknown';
  }

  // Named channel rather than a version: claude-mythos-preview ships this way
  // alongside the numbered claude-mythos-5, so the version segment is not
  // always numeric.
  const channelMatch = model.match(
    new RegExp(`^claude-(${FAMILY_ALTERNATION})-(preview)$`, 'i'),
  );
  if (channelMatch) {
    const [, modelType, channel] = channelMatch;
    return `Claude ${capitalise(modelType)} ${capitalise(channel)}`;
  }

  // New format: claude-{type}-{major}[-{minor}][-{date}]
  const newFormatMatch = model.match(
    new RegExp(
      `^claude-(${FAMILY_ALTERNATION})-(\\d+)(?:-(\\d{1,2}))?(?:-\\d{8})?$`,
      'i',
    ),
  );
  if (newFormatMatch) {
    const [, modelType, major, minor] = newFormatMatch;
    const modelName = capitalise(modelType);
    const version = minor ? `${major}.${minor}` : major;
    return `Claude ${modelName} ${version}`;
  }

  // Old format: claude-{major}[-{minor}]-{type}-{date}
  const oldFormatMatch = model.match(
    new RegExp(
      `^claude-(\\d+)(?:-(\\d+))?-(${FAMILY_ALTERNATION})-\\d{8}$`,
      'i',
    ),
  );
  if (oldFormatMatch) {
    const [, major, minor, modelType] = oldFormatMatch;
    const modelName = capitalise(modelType);
    const version = minor ? `${major}.${minor}` : major;
    return `Claude ${modelName} ${version}`;
  }

  return model;
};

// Returns CSS badge class name based on the model family
const getModelBadgeClass = (model: string | null | undefined): string => {
  if (!model) return '';
  for (const family of MODEL_FAMILIES) {
    if (model.includes(family)) return family;
  }
  return '';
};

export {
  DEFAULT_MODEL_TIMELINE,
  formatModelName,
  getModelBadgeClass,
  inferModel,
  MODEL_FAMILIES,
};
