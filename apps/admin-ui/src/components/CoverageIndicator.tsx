import styles from './CoverageIndicator.module.css';

const COVERAGE_LABELS = {
  coverageTitle: 'Section Coverage',
  covered: 'Covered',
  notCovered: 'Not yet covered',
} as const;

interface CoverageEntry {
  sessionCount: number;
  avgDepth?: string;
  reviewerIds?: string[];
}

interface SectionInfo {
  id: string;
  title: string;
}

interface Props {
  sections: SectionInfo[];
  coverageMap: Record<string, CoverageEntry>;
}

/**
 * Per-section coverage bar: covered (green) vs. not yet covered (warning).
 * Shown when completed sessions exist and coverageMap is present.
 * Uses labels registry for all copy.
 */
export default function CoverageIndicator({ sections, coverageMap }: Props) {
  if (sections.length === 0) return null;

  return (
    <div className={styles.panel}>
      <h3 className={styles.title}>{COVERAGE_LABELS.coverageTitle}</h3>

      {sections.map((section) => {
        const entry = coverageMap[section.id];
        const isCovered = entry && entry.sessionCount > 0;

        return (
          <div key={section.id} className={styles.row}>
            <span className={styles.sectionName}>{section.title}</span>
            <div className={styles.bar} aria-hidden="true">
              <div
                className={`${styles.barFill} ${
                  isCovered ? styles.barCovered : styles.barNotCovered
                }`}
              />
            </div>
            <span
              className={`${styles.statusLabel} ${
                isCovered ? styles.covered : styles.notCovered
              }`}
            >
              {isCovered ? COVERAGE_LABELS.covered : COVERAGE_LABELS.notCovered}
            </span>
          </div>
        );
      })}
    </div>
  );
}
