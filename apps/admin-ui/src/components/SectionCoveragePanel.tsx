import styles from './SectionCoveragePanel.module.css';
import { labels } from '../config/labels-registry';

interface SectionCoveragePanelProps {
  sections: Array<{ id: string; title: string }>;
  coverageMap: Record<string, { sessionCount: number }>;
  depthPreferences: Record<string, 'deep' | 'explore' | 'skim'>;
}

/**
 * Compact summary panel showing per-section coverage status and depth preferences.
 * Pure render — no state, no effects.
 */
export default function SectionCoveragePanel({
  sections,
  coverageMap,
  depthPreferences,
}: SectionCoveragePanelProps) {
  if (sections.length === 0) return null;

  const coveredCount = sections.filter(
    (s) => (coverageMap[s.id]?.sessionCount ?? 0) > 0,
  ).length;

  return (
    <div className={styles.wrapper}>
      <div className={styles.header}>
        <h3 className={styles.heading}>{labels.sections.coveragePanelTitle}</h3>
        <p className={styles.description}>
          {coveredCount === sections.length
            ? labels.sections.coverageFull
            : labels.sections.coveragePartial
                .replace('{covered}', String(coveredCount))
                .replace('{total}', String(sections.length))}
        </p>
      </div>
      <div className={styles.panel} role="list" aria-label="Section coverage">
        {sections.map((section) => {
          const isCovered = (coverageMap[section.id]?.sessionCount ?? 0) > 0;
          const depth = depthPreferences[section.id];

          return (
            <div key={section.id} className={styles.row} role="listitem">
              <span className={styles.sectionName}>{section.title}</span>
              {depth && <span className={styles.depthBadge}>{depth}</span>}
              <span
                className={`${styles.coverageIndicator} ${isCovered ? styles.covered : styles.notCovered}`}
                aria-label={isCovered ? 'Covered' : 'Not covered'}
              >
                {isCovered ? '✓' : '○'}
              </span>
            </div>
          );
        })}
      </div>
      <hr className={styles.divider} />
    </div>
  );
}
