import { useQueryClient } from '@tanstack/react-query';

interface EnrichedFeature {
  allowed: boolean;
  reason: string;
  limit: number | null;
}

interface SettingsResponse {
  data: {
    enrichedFeatures: Record<string, EnrichedFeature>;
  };
}

export function useCan(featureName: string): { allowed: boolean; limit: number | null } {
  const queryClient = useQueryClient();
  const cached = queryClient.getQueryData<SettingsResponse>(['settings']);

  if (!cached?.data?.enrichedFeatures?.[featureName]) {
    return { allowed: true, limit: null }; // optimistic default while loading
  }

  const feature = cached.data.enrichedFeatures[featureName];
  return { allowed: feature.allowed, limit: feature.limit };
}
