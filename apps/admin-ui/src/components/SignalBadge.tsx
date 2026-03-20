import styles from './SignalBadge.module.css';

export type SignalType = 'conviction' | 'tension' | 'uncertainty';
export type EnergyLevel = 'engaged' | 'neutral' | 'resistant';
export type BadgeVariant = SignalType | EnergyLevel;

const SIGNAL_LABELS: Record<SignalType, string> = {
  conviction: 'Conviction',
  tension: 'Tension',
  uncertainty: 'Uncertainty',
};

const ENERGY_LABELS: Record<EnergyLevel, string> = {
  engaged: 'Engaged',
  neutral: 'Neutral',
  resistant: 'Resistant',
};

interface SignalBadgeProps {
  variant: BadgeVariant;
  /** Override the default label */
  label?: string;
  className?: string;
}

/**
 * Small badge for signal types (Conviction / Tension / Uncertainty)
 * and energy levels (Engaged / Neutral / Resistant).
 * Requirements: 11.7
 */
export default function SignalBadge({ variant, label, className }: SignalBadgeProps) {
  const defaultLabel =
    variant in SIGNAL_LABELS
      ? SIGNAL_LABELS[variant as SignalType]
      : ENERGY_LABELS[variant as EnergyLevel];

  return (
    <span className={`${styles.badge} ${styles[variant]} ${className ?? ''}`}>
      {label ?? defaultLabel}
    </span>
  );
}
