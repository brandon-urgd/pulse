import { Amplify } from 'aws-amplify';

const userPoolId = import.meta.env.VITE_USER_POOL_ID as string;
const userPoolClientId = import.meta.env.VITE_USER_POOL_CLIENT_ID as string;
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN as string;

export function configureAmplify(): void {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: {
          oauth: {
            domain: cognitoDomain,
            scopes: ['email', 'openid', 'profile'],
            redirectSignIn: [`${window.location.origin}/admin/items`],
            redirectSignOut: [`${window.location.origin}/admin/login`],
            responseType: 'code',
          },
        },
      },
    },
  });
}
