/**
 * Token Count Estimation Utilities for Prompt Editor
 *
 * Provides token counting functionality for different AI models
 * as specified in the Prompt Editor Module specification.
 */

import type { TokenEstimate } from '../types.js';

/**
 * Model-specific token estimation rules
 */
interface ModelTokenizer {
  /** Average characters per token */
  avgCharsPerToken: number;
  /** Whitespace handling factor */
  whitespaceMultiplier: number;
  /** Special token overhead */
  overhead: number;
  /** Cost per 1K tokens (in cents) */
  costPer1kTokens?: number;
}

/**
 * Token estimation rules for different models
 */
const MODEL_TOKENIZERS: Record<string, ModelTokenizer> = {
  'gpt-4': {
    avgCharsPerToken: 4.0,
    whitespaceMultiplier: 0.8,
    overhead: 10,
    costPer1kTokens: 3.0 // $0.03 per 1K tokens (input)
  },
  'gpt-3.5-turbo': {
    avgCharsPerToken: 4.0,
    whitespaceMultiplier: 0.8,
    overhead: 8,
    costPer1kTokens: 0.15 // $0.0015 per 1K tokens (input)
  },
  'claude-3': {
    avgCharsPerToken: 3.8,
    whitespaceMultiplier: 0.85,
    overhead: 12,
    costPer1kTokens: 1.5 // $0.015 per 1K tokens (input)
  },
  'claude-3-haiku': {
    avgCharsPerToken: 3.8,
    whitespaceMultiplier: 0.85,
    overhead: 8,
    costPer1kTokens: 0.25 // $0.0025 per 1K tokens (input)
  },
  'gemini': {
    avgCharsPerToken: 4.2,
    whitespaceMultiplier: 0.9,
    overhead: 15,
    costPer1kTokens: 0.5 // $0.005 per 1K tokens (input)
  }
};

/**
 * Estimate token count for text using model-specific rules
 */
export function estimateTokenCount(
  text: string,
  model: string = 'gpt-4'
): TokenEstimate {
  const tokenizer = MODEL_TOKENIZERS[model] || MODEL_TOKENIZERS['gpt-4'];

  // Basic character-based estimation
  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter(word => word.length > 0).length;

  // Adjust for whitespace and special characters
  const adjustedCharCount = charCount * tokenizer.whitespaceMultiplier;

  // Calculate base token estimate
  const baseTokens = Math.ceil(adjustedCharCount / tokenizer.avgCharsPerToken);

  // Add overhead for special tokens
  const totalTokens = baseTokens + tokenizer.overhead;

  // Calculate cost estimate
  const costEstimate = tokenizer.costPer1kTokens
    ? (totalTokens / 1000) * tokenizer.costPer1kTokens
    : undefined;

  return {
    count: totalTokens,
    approximate: true,
    costEstimate,
    model
  };
}

/**
 * Get detailed token breakdown for analysis
 */
export function getTokenBreakdown(
  text: string,
  model: string = 'gpt-4'
): {
  total: number;
  sections: Array<{ name: string; tokens: number; percentage: number }>;
  efficiency: number;
} {
  const lines = text.split('\n');
  const sections: Array<{ name: string; tokens: number; percentage: number }> = [];
  let totalTokens = 0;

  // Analyze different sections
  let currentSection = 'content';
  let sectionText = '';

  for (const line of lines) {
    const trimmedLine = line.trim().toLowerCase();

    // Detect section headers
    if (trimmedLine.includes('context:') || trimmedLine.includes('background:')) {
      if (sectionText) {
        const tokens = estimateTokenCount(sectionText, model).count;
        sections.push({
          name: currentSection,
          tokens,
          percentage: 0 // Will calculate after total
        });
        totalTokens += tokens;
      }
      currentSection = 'context';
      sectionText = '';
    } else if (trimmedLine.includes('task:') || trimmedLine.includes('objective:')) {
      if (sectionText) {
        const tokens = estimateTokenCount(sectionText, model).count;
        sections.push({
          name: currentSection,
          tokens,
          percentage: 0
        });
        totalTokens += tokens;
      }
      currentSection = 'task';
      sectionText = '';
    } else if (trimmedLine.includes('example') || trimmedLine.includes('sample')) {
      if (sectionText) {
        const tokens = estimateTokenCount(sectionText, model).count;
        sections.push({
          name: currentSection,
          tokens,
          percentage: 0
        });
        totalTokens += tokens;
      }
      currentSection = 'examples';
      sectionText = '';
    } else if (trimmedLine.includes('constraint') || trimmedLine.includes('requirement')) {
      if (sectionText) {
        const tokens = estimateTokenCount(sectionText, model).count;
        sections.push({
          name: currentSection,
          tokens,
          percentage: 0
        });
        totalTokens += tokens;
      }
      currentSection = 'constraints';
      sectionText = '';
    } else {
      sectionText += line + '\n';
    }
  }

  // Add final section
  if (sectionText) {
    const tokens = estimateTokenCount(sectionText, model).count;
    sections.push({
      name: currentSection,
      tokens,
      percentage: 0
    });
    totalTokens += tokens;
  }

  // Calculate percentages
  sections.forEach(section => {
    section.percentage = totalTokens > 0 ? (section.tokens / totalTokens) * 100 : 0;
  });

  // Calculate efficiency score (based on task-to-fluff ratio)
  const taskTokens = sections.find(s => s.name === 'task')?.tokens || 0;
  const totalNonTaskTokens = totalTokens - taskTokens;
  const efficiency = totalTokens > 0 ? Math.min(100, (taskTokens / totalTokens) * 100 + 50) : 0;

  return {
    total: totalTokens,
    sections,
    efficiency: Math.round(efficiency)
  };
}

/**
 * Compare token estimates across different models
 */
export function compareModels(text: string): Array<{
  model: string;
  estimate: TokenEstimate;
  costEfficiency: number;
}> {
  const comparisons = Object.keys(MODEL_TOKENIZERS).map(model => {
    const estimate = estimateTokenCount(text, model);
    const costEfficiency = estimate.costEstimate
      ? Math.round((1 / estimate.costEstimate) * 1000) // Higher is better
      : 0;

    return {
      model,
      estimate,
      costEfficiency
    };
  });

  // Sort by cost efficiency (best value first)
  return comparisons.sort((a, b) => b.costEfficiency - a.costEfficiency);
}

/**
 * Get token usage recommendations
 */
export function getTokenRecommendations(
  text: string,
  model: string = 'gpt-4'
): Array<{ type: 'info' | 'warning' | 'error'; message: string }> {
  const estimate = estimateTokenCount(text, model);
  const breakdown = getTokenBreakdown(text, model);
  const recommendations: Array<{ type: 'info' | 'warning' | 'error'; message: string }> = [];

  // Token count warnings
  if (estimate.count > 8000) {
    recommendations.push({
      type: 'error',
      message: 'Prompt is very long and may exceed model limits. Consider splitting into smaller parts.'
    });
  } else if (estimate.count > 4000) {
    recommendations.push({
      type: 'warning',
      message: 'Prompt is quite long. Consider optimizing for better performance and cost.'
    });
  } else if (estimate.count < 50) {
    recommendations.push({
      type: 'warning',
      message: 'Prompt may be too short for complex tasks. Consider adding more context.'
    });
  }

  // Cost warnings
  if (estimate.costEstimate && estimate.costEstimate > 0.1) {
    recommendations.push({
      type: 'warning',
      message: `Estimated cost: $${estimate.costEstimate.toFixed(3)}. Consider optimizing to reduce costs.`
    });
  }

  // Efficiency recommendations
  if (breakdown.efficiency < 30) {
    recommendations.push({
      type: 'warning',
      message: 'Prompt has low task-to-context ratio. Consider focusing more on the specific task.'
    });
  }

  // Section balance recommendations
  const taskSection = breakdown.sections.find(s => s.name === 'task');
  const examplesSection = breakdown.sections.find(s => s.name === 'examples');

  if (!taskSection || taskSection.percentage < 20) {
    recommendations.push({
      type: 'warning',
      message: 'Task definition appears weak. Consider strengthening the task description.'
    });
  }

  if (!examplesSection && estimate.count > 100) {
    recommendations.push({
      type: 'info',
      message: 'Consider adding examples to improve AI understanding of the task.'
    });
  }

  return recommendations;
}

/**
 * Format token count display
 */
export function formatTokenDisplay(estimate: TokenEstimate): string {
  const parts = [`${estimate.count} tokens`];

  if (estimate.approximate) {
    parts.push('(estimated)');
  }

  if (estimate.costEstimate) {
    parts.push(`~$${estimate.costEstimate.toFixed(3)}`);
  }

  parts.push(`(${estimate.model})`);

  return parts.join(' ');
}