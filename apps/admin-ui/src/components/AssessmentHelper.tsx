import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authedMutate } from '../hooks/useAuthedMutation';
import { labels } from '../config/labels-registry';
import styles from './AssessmentHelper.module.css';

interface Props {
  itemId: string | null;
  itemType: 'document' | 'image';
  description: string;
  hasDocument: boolean;
  onUseSuggestion: (text: string) => void;
  onEditSuggestion: (text: string) => void;
  onAppendExample: (text: string) => void;
}

/**
 * Expandable panel below description textarea.
 * Static examples by itemType + Generate button → calls suggestDescription Lambda.
 * Uses labels registry for all copy.
 */
export default function AssessmentHelper({
  itemId,
  itemType,
  description,
  hasDocument,
  onUseSuggestion,
  onEditSuggestion,
  onAppendExample,
}: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [noInputMessage, setNoInputMessage] = useState('');

  const staticExamples =
    itemType === 'image'
      ? labels.assessmentHelper.staticExamplesImage
      : labels.assessmentHelper.staticExamplesDocument;

  const generateDisabled = !itemId || isGenerating;

  // Contextual hint — adapts based on what the user has provided so far
  const hasInput = description.trim().length > 0;
  const contextualHint = !hasDocument && !hasInput
    ? labels.assessmentHelper.hintNoDocNoInput
    : hasDocument && !hasInput
    ? labels.assessmentHelper.hintDocNoInput
    : !hasDocument && hasInput
    ? labels.assessmentHelper.hintInputNoDoc
    : null;

  async function handleGenerate() {
    if (!itemId) return;

    // No input and no document → inline message, no Bedrock call
    if (!description.trim() && !hasDocument) {
      setNoInputMessage(labels.assessmentHelper.noInputMessage);
      return;
    }

    setNoInputMessage('');
    setError('');
    setIsGenerating(true);
    setSuggestion(null);

    try {
      const resp = await authedMutate(
        `/api/manage/items/${itemId}/suggest-description`,
        'POST',
        { roughInput: description.trim(), itemType },
        navigate
      ) as { data: { suggestion: string } };
      setSuggestion(resp.data.suggestion);
    } catch {
      setError(labels.assessmentHelper.errorMessage);
    } finally {
      setIsGenerating(false);
    }
  }

  function handleUseThis() {
    if (suggestion) {
      onUseSuggestion(suggestion);
      setSuggestion(null);
      setExpanded(false);
    }
  }

  function handleEditFirst() {
    if (suggestion) {
      onEditSuggestion(suggestion);
      setSuggestion(null);
      setExpanded(false);
    }
  }

  if (!expanded) {
    return (
      <button
        type="button"
        className={styles.trigger}
        onClick={() => setExpanded(true)}
      >
        {labels.assessmentHelper.trigger}
      </button>
    );
  }

  return (
    <div className={styles.panel}>
      {contextualHint && (
        <p className={styles.contextualHint}>{contextualHint}</p>
      )}
      <p className={styles.examplesHeading}>Examples</p>
      {staticExamples.map((example, i) => (
        <button
          key={i}
          type="button"
          className={styles.exampleButton}
          onClick={() => onAppendExample(example)}
        >
          {example}
        </button>
      ))}

      <div className={styles.generateRow}>
        <button
          type="button"
          className={styles.generateButton}
          onClick={handleGenerate}
          disabled={generateDisabled}
          title={!itemId ? labels.assessmentHelper.generateDisabledTooltip : undefined}
        >
          {isGenerating ? 'Generating…' : labels.assessmentHelper.generateButton}
        </button>
      </div>

      {noInputMessage && (
        <p className={styles.inlineMessage}>{noInputMessage}</p>
      )}

      {error && (
        <p className={styles.errorMessage} role="alert">{error}</p>
      )}

      {suggestion && (
        <div>
          <div className={styles.suggestion}>{suggestion}</div>
          <div className={styles.suggestionActions}>
            <button type="button" className={styles.useButton} onClick={handleUseThis}>
              {labels.assessmentHelper.useThis}
            </button>
            <button type="button" className={styles.editButton} onClick={handleEditFirst}>
              {labels.assessmentHelper.editFirst}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
