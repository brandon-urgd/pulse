import { Amplify } from 'aws-amplify';

const userPoolId = import.meta.env.VITE_USER_POOL_ID as string;
const userPoolClientId = import.meta.env.VITE_USER_POOL_CLIENT_ID as string;
// Strip https:// prefix — Amplify's oauth.domain expects hostname only
const cognitoDomain = (import.meta.env.VITE_COGNITO_DOMAIN as string).replace(/^https?:\/\//, '');

export function configureAmplify(): void {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: {
          email: true,
          oauth: {
            domain: cognitoDomain,
            scopes: ['email', 'openid', 'profile'],
            // Both redirect to / — SplashEntry is always rendered there and
            // Amplify can process the OAuth code before ProtectedRoute runs.
            redirectSignIn: [`${window.location.origin}/`],
            redirectSignOut: [`${window.location.origin}/`],
            responseType: 'code',
          },
        },
      },
    },
  });
}
