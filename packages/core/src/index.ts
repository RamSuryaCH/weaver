export {
  COLLECTOR_ID_PATTERN,
  CREATE_DESCRIPTION_MAX_CHARS,
  FIELD_TYPES,
  findField,
  HEAL_POLICIES,
  HEAL_PROMPT_MAX_CHARS,
  isNumericType,
  parseSourceContract,
  requiredFields,
  SCRAPER_TYPES,
  type DriftRules,
  type Expectations,
  type FieldContract,
  type FieldType,
  type HealPolicy,
  type ScraperType,
  type SourceContract,
  type SourceInputs,
  type SourcePolicy,
  type ValidationRules,
} from './contract.js';

export {
  buildBaseline,
  detectDrift,
  findingsFor,
  MIN_BASELINE_RUNS,
  type Baseline,
  type BaselineField,
  type DetectDriftInput,
  type RunReport,
} from './drift.js';

export {
  FINDING_CODES,
  isAtLeast,
  isHealable,
  SEVERITIES,
  worstSeverity,
  type Finding,
  type FindingCode,
  type Severity,
} from './findings.js';

export {
  computeRunStatistics,
  median,
  percentChange,
  readFieldValue,
  type FieldStatistics,
  type FieldValue,
  type NumericSummary,
  type RunStatistics,
} from './statistics.js';

export {
  applyChaos,
  ChaosConfigurationError,
  CHAOS_MUTATIONS,
  describeMutation,
  type ChaosMutation,
  type ChaosOptions,
} from './chaos.js';

export {
  chooseStrategy,
  NothingToHealError,
  synthesizeHealPrompt,
  type HealPrompt,
  type HealPromptInput,
  type HealStrategy,
} from './heal-prompt.js';

export { describeVerdict, verifyPreview, type PreviewVerdict } from './preview.js';

export {
  compareByMolecule,
  moleculeKey,
  parsePackSize,
  readOffer,
  readOffers,
  type MoleculeComparison,
  type PharmacyOffer,
} from './catalogue.js';
