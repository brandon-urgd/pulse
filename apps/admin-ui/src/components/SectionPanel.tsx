import { labels } from '../config/labels-registry';
import styles from './SectionPanel.module.css';

export interface Section {
  id: string;
  title: string;
  classification: 'substantive' | 'lightweight';
}

interface Props {
  sections: Section[];
  feedbackSections: string[];
  sectionDepthPreferences: Record<string, 'deep' | 'explore' | 'skim'>;
  onToggleSection: (sectionId: string, included: boolean) => void;
  onChangeDepth: (sectionId: string, depth: 'deep' | 'explore' | 'skim') => void;
  disabled?: boolean;
}

/**
 * Shows detected sections with title, classification badge, include toggle,
 * and depth selector. Uses labels registry for all copy.
 */
export default function SectionPanel({
  sections,
  feedbackSections,
  sectionDepthPreferences,
  onToggleSection,
  onChangeDepth,
  disabled = false,
}: Props) {
  const allExcluded = feedbackSections.length === 0;

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>{labels.sections.sectionPanelTitle}</h3>

      {sections.length === 0 ? (
        <p className={styles.analyzing}>{labels.sections.noSections}</p>
      ) : (
        sections.map((section) => {
          const included = feedbackSections.includes(section.id);
          const depth = sectionDepthPreferences[section.id] ?? 'explore';
          const isSubstantive = section.classification === 'substantive';

          return (
            <div key={section.id} className={styles.sectionRow}>
              <div className={styles.sectionInfo}>
                <span className={styles.sectionTitle}>{section.title}</span>
                <span
                  className={`${styles.badge} ${
                    isSubstantive ? styles.badgeSubstantive : styles.badgeLightweight
                  }`}
                >
                  {isSubstantive ? labels.sections.keySection : labels.sections.supporting}
                </span>
              </div>

              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={included}
                  onChange={(e) => onToggleSection(section.id, e.target.checked)}
                  disabled={disabled}
                  aria-label={`${labels.sections.includeToggle}: ${section.title}`}
                />
              </label>

              <select
                className={styles.depthSelect}
                value={depth}
                onChange={(e) =>
                  onChangeDepth(section.id, e.target.value as 'deep' | 'explore' | 'skim')
                }
                disabled={disabled || !included}
                aria-label={`Depth for ${section.title}`}
              >
                <option value="deep">{labels.sections.depthDeep}</option>
                <option value="explore">{labels.sections.depthExplore}</option>
                <option value="skim">{labels.sections.depthSkim}</option>
              </select>
            </div>
          );
        })
      )}

      {allExcluded && sections.length > 0 && (
        <p className={styles.validation} role="alert">
          {labels.sections.validationAllExcluded}
        </p>
      )}
    </div>
  );
}
