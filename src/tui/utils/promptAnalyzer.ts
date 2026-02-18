/**
 * Prompt Analysis Utilities for Prompt Editor
 *
 * Provides prompt quality analysis, structure evaluation, and optimization suggestions
 * as specified in the Prompt Editor Module specification.
 */

import type {
  PromptAnalysis,
  StructureAnalysis,
  ClarityAnalysis,
  CompletenessAnalysis,
  PromptSuggestion
} from '../types.js';

/**
 * Ambiguous words that may reduce clarity
 */
const AMBIGUOUS_WORDS = [
  'some', 'several', 'many', 'few', 'often', 'sometimes', 'usually',
  'probably', 'maybe', 'might', 'could', 'should', 'would',
  'good', 'bad', 'nice', 'appropriate', 'suitable', 'reasonable',
  'quickly', 'slowly', 'carefully', 'properly', 'correctly'
];

/**
 * Passive voice indicators
 */
const PASSIVE_VOICE_PATTERNS = [
  /\b(is|are|was|were|being|been)\s+\w*ed\b/gi,
  /\b(is|are|was|were|being|been)\s+\w*en\b/gi,
  /\bby\s+\w+\b/gi
];

/**
 * Task definition keywords
 */
const TASK_KEYWORDS = [
  'task', 'objective', 'goal', 'purpose', 'mission', 'job',
  'create', 'generate', 'write', 'analyze', 'summarize', 'explain',
  'develop', 'design', 'implement', 'build', 'make', 'produce'
];

/**
 * Context keywords
 */
const CONTEXT_KEYWORDS = [
  'context', 'background', 'situation', 'scenario', 'setting',
  'given', 'assuming', 'suppose', 'considering', 'based on'
];

/**
 * Constraint keywords
 */
const CONSTRAINT_KEYWORDS = [
  'constraint', 'requirement', 'limitation', 'restriction', 'rule',
  'must', 'should', 'cannot', 'avoid', 'ensure', 'never', 'always'
];

/**
 * Example keywords
 */
const EXAMPLE_KEYWORDS = [
  'example', 'sample', 'instance', 'illustration', 'demonstration',
  'for example', 'such as', 'like', 'including', 'e.g.'
];

/**
 * Analyze prompt structure and quality
 */
export function analyzePrompt(text: string): PromptAnalysis {
  const structure = analyzeStructure(text);
  const clarity = analyzeClarity(text);
  const completeness = analyzeCompleteness(text);
  const suggestions = generateSuggestions(text, structure, clarity, completeness);

  // Calculate overall quality score
  const qualityScore = Math.round(
    (structure.score * 0.3 + clarity.clarityScore * 0.3 + completeness.score * 0.4)
  );

  return {
    qualityScore,
    structure,
    clarity,
    completeness,
    suggestions
  };
}

/**
 * Analyze prompt structure
 */
export function analyzeStructure(text: string): StructureAnalysis {
  const lowerText = text.toLowerCase();

  const hasContext = CONTEXT_KEYWORDS.some(keyword => lowerText.includes(keyword));
  const hasTask = TASK_KEYWORDS.some(keyword => lowerText.includes(keyword));
  const hasConstraints = CONSTRAINT_KEYWORDS.some(keyword => lowerText.includes(keyword));
  const hasExamples = EXAMPLE_KEYWORDS.some(keyword => lowerText.includes(keyword));

  // Check for clear structure indicators (headers, sections, numbering)
  const hasHeaders = /^#+\s|\*\*\w+\*\*|^\d+\.|^-\s/m.test(text);
  const hasSections = text.split('\n\n').length > 2;

  const hasClearStructure = hasHeaders || hasSections;

  // Calculate structure score
  let score = 0;
  if (hasClearStructure) score += 25;
  if (hasContext) score += 20;
  if (hasTask) score += 30;
  if (hasConstraints) score += 15;
  if (hasExamples) score += 10;

  return {
    hasClearStructure,
    hasContext,
    hasTask,
    hasConstraints,
    hasExamples,
    score
  };
}

/**
 * Analyze prompt clarity
 */
export function analyzeClarity(text: string): ClarityAnalysis {
  const sentences = splitIntoSentences(text);
  const words = text.split(/\s+/).filter(word => word.length > 0);

  // Average sentence length
  const totalSentenceLength = sentences.reduce((sum, sentence) => sum + sentence.length, 0);
  const avgSentenceLength = sentences.length > 0 ? totalSentenceLength / sentences.length : 0;

  // Count ambiguous words
  const ambiguousWordCount = words.filter(word =>
    AMBIGUOUS_WORDS.some(ambiguous =>
      word.toLowerCase().includes(ambiguous.toLowerCase())
    )
  ).length;

  // Count passive voice instances
  let passiveVoiceCount = 0;
  for (const pattern of PASSIVE_VOICE_PATTERNS) {
    const matches = text.match(pattern);
    if (matches) {
      passiveVoiceCount += matches.length;
    }
  }

  const passiveVoiceRatio = sentences.length > 0 ? passiveVoiceCount / sentences.length : 0;

  // Calculate clarity score
  let clarityScore = 100;

  // Penalize very long sentences
  if (avgSentenceLength > 150) clarityScore -= 20;
  else if (avgSentenceLength > 100) clarityScore -= 10;

  // Penalize ambiguous words
  const ambiguousRatio = words.length > 0 ? ambiguousWordCount / words.length : 0;
  if (ambiguousRatio > 0.1) clarityScore -= 20;
  else if (ambiguousRatio > 0.05) clarityScore -= 10;

  // Penalize excessive passive voice
  if (passiveVoiceRatio > 0.3) clarityScore -= 15;
  else if (passiveVoiceRatio > 0.15) clarityScore -= 5;

  clarityScore = Math.max(0, clarityScore);

  return {
    avgSentenceLength,
    ambiguousWordCount,
    passiveVoiceRatio,
    clarityScore
  };
}

/**
 * Analyze prompt completeness
 */
export function analyzeCompleteness(text: string): CompletenessAnalysis {
  const lowerText = text.toLowerCase();

  const hasTaskDefinition = TASK_KEYWORDS.some(keyword => lowerText.includes(keyword));
  const hasContext = CONTEXT_KEYWORDS.some(keyword => lowerText.includes(keyword));

  // Check for output format specifications
  const hasOutputFormat = /format|structure|layout|template|json|xml|csv|table|list/.test(lowerText);

  // Check for examples
  const hasExamples = EXAMPLE_KEYWORDS.some(keyword => lowerText.includes(keyword));

  // Calculate completeness score
  let score = 0;
  if (hasTaskDefinition) score += 40;
  if (hasContext) score += 25;
  if (hasOutputFormat) score += 20;
  if (hasExamples) score += 15;

  return {
    hasTaskDefinition,
    hasContext,
    hasOutputFormat,
    hasExamples,
    score
  };
}

/**
 * Generate optimization suggestions
 */
export function generateSuggestions(
  text: string,
  structure: StructureAnalysis,
  clarity: ClarityAnalysis,
  completeness: CompletenessAnalysis
): PromptSuggestion[] {
  const suggestions: PromptSuggestion[] = [];
  const wordCount = text.split(/\s+/).filter(word => word.length > 0).length;

  // Structure suggestions
  if (!structure.hasClearStructure) {
    suggestions.push({
      type: 'structure',
      message: 'Prompt lacks clear structure',
      suggestion: 'Consider using headers, bullet points, or numbered sections to organize your prompt',
      priority: 'high'
    });
  }

  if (!structure.hasTask) {
    suggestions.push({
      type: 'structure',
      message: 'No clear task definition found',
      suggestion: 'Start with a clear statement of what you want the AI to do (e.g., "Create...", "Analyze...", "Generate...")',
      priority: 'high'
    });
  }

  if (!structure.hasContext && wordCount > 50) {
    suggestions.push({
      type: 'structure',
      message: 'Consider adding context',
      suggestion: 'Provide background information to help the AI understand the situation better',
      priority: 'medium'
    });
  }

  // Clarity suggestions
  if (clarity.avgSentenceLength > 100) {
    suggestions.push({
      type: 'clarity',
      message: 'Sentences are too long',
      suggestion: 'Break down long sentences into shorter, clearer statements',
      priority: 'medium'
    });
  }

  if (clarity.ambiguousWordCount > 3) {
    suggestions.push({
      type: 'clarity',
      message: 'Too many ambiguous words detected',
      suggestion: 'Replace vague terms like "some", "good", "appropriate" with specific, measurable criteria',
      priority: 'medium'
    });
  }

  if (clarity.passiveVoiceRatio > 0.2) {
    suggestions.push({
      type: 'clarity',
      message: 'Excessive passive voice usage',
      suggestion: 'Use active voice for clearer, more direct instructions',
      priority: 'low'
    });
  }

  // Completeness suggestions
  if (!completeness.hasOutputFormat && wordCount > 100) {
    suggestions.push({
      type: 'completeness',
      message: 'No output format specified',
      suggestion: 'Specify the desired format for the AI\'s response (e.g., bullet points, JSON, paragraph)',
      priority: 'medium'
    });
  }

  if (!completeness.hasExamples && wordCount > 150) {
    suggestions.push({
      type: 'completeness',
      message: 'Consider adding examples',
      suggestion: 'Include examples to clarify your expectations and improve AI understanding',
      priority: 'low'
    });
  }

  // Length suggestions
  if (wordCount < 10) {
    suggestions.push({
      type: 'completeness',
      message: 'Prompt is very short',
      suggestion: 'Add more detail and context to help the AI understand your needs',
      priority: 'high'
    });
  } else if (wordCount > 500) {
    suggestions.push({
      type: 'efficiency',
      message: 'Prompt is very long',
      suggestion: 'Consider breaking this into multiple focused prompts or removing unnecessary details',
      priority: 'medium'
    });
  }

  // Specificity suggestions
  const hasSpecificDetails = /\d+|specific|exactly|precisely|must|requirement/.test(text.toLowerCase());
  if (!hasSpecificDetails && wordCount > 50) {
    suggestions.push({
      type: 'specificity',
      message: 'Prompt lacks specific details',
      suggestion: 'Add specific requirements, constraints, or criteria to get more targeted results',
      priority: 'medium'
    });
  }

  return suggestions.sort((a, b) => {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    return priorityOrder[b.priority] - priorityOrder[a.priority];
  });
}

/**
 * Split text into sentences
 */
function splitIntoSentences(text: string): string[] {
  // Simple sentence splitting - can be enhanced with more sophisticated NLP
  return text
    .split(/[.!?]+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 0);
}

/**
 * Get prompt quality rating
 */
export function getQualityRating(score: number): {
  rating: string;
  color: string;
  description: string;
} {
  if (score >= 80) {
    return {
      rating: 'Excellent',
      color: 'green',
      description: 'Well-structured prompt with clear objectives and good clarity'
    };
  } else if (score >= 60) {
    return {
      rating: 'Good',
      color: 'blue',
      description: 'Solid prompt with room for minor improvements'
    };
  } else if (score >= 40) {
    return {
      rating: 'Fair',
      color: 'yellow',
      description: 'Adequate prompt but could benefit from better structure or clarity'
    };
  } else {
    return {
      rating: 'Needs Improvement',
      color: 'red',
      description: 'Prompt needs significant improvement in structure, clarity, or completeness'
    };
  }
}

/**
 * Format analysis summary for display
 */
export function formatAnalysisSummary(analysis: PromptAnalysis): string {
  const rating = getQualityRating(analysis.qualityScore);

  const parts = [
    `Quality Score: ${analysis.qualityScore}/100 (${rating.rating})`,
    `Structure: ${analysis.structure.score}/100`,
    `Clarity: ${analysis.clarity.clarityScore}/100`,
    `Completeness: ${analysis.completeness.score}/100`
  ];

  if (analysis.suggestions.length > 0) {
    const highPriority = analysis.suggestions.filter(s => s.priority === 'high').length;
    parts.push(`Suggestions: ${analysis.suggestions.length} (${highPriority} high priority)`);
  }

  return parts.join(' | ');
}