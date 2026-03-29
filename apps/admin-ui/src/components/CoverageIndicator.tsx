import { labels } from '../config/labels-registry';
import styles from './CoverageIndicator.module.css';

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
      <h3 className={styles.title}>{labels.coverage.coverageTitle}</h3>

      {sections.map((section) => {
        const entry = coverageMap[section.id];
        const isCovered = entry && entry.sessionCount > 0;

        return (
          <div key={section.id} className={styles.row}>
            <span className={styles.sectionName}>{section.title}</span>
            <div className={styles.bar}>
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
              {isCovered ? labels.coverage.covered : labels.coverage.notCovered}
            </span>
          </div>
        );
      })}
    </div>
  );
}
