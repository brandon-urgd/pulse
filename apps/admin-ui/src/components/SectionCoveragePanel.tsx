import styles from './SectionCoveragePanel.module.css';

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

  return (
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
  );
}
