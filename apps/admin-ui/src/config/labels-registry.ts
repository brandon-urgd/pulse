// All user-facing strings — no hardcoded text in components

export const labels = {
  // Auth — Login
  login: {
    title: 'Sign in to Pulse',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    submitButton: 'Sign in',
    appleButton: 'Continue with Apple',
    googleButton: 'Continue with Google',
    invalidCredentials: 'Incorrect email or password. Try again.',
    newPasswordRequired: 'Setting password for {email}',
    newPasswordLabel: 'New password',
    newPasswordSubmit: 'Set password',
    forgotPassword: 'Forgot password?',
  },

  // Auth — Register
  register: {
    title: 'Create your account',
    nameLabel: 'Name',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    submitButton: 'Create account',
    verificationTitle: 'Check your email',
    verificationDescription: 'We sent a verification code to {email}.',
    verificationCodeLabel: 'Verification code',
    verifyButton: 'Verify',
    resendButton: 'Resend code',
    resendCooldown: 'Resend in {seconds}s',
    codeSent: 'Code resent. Check your inbox.',
    invalidCode: "That code isn't right. Check your email and try again.",
    expiredCode: 'That code has expired. Request a new one.',
    emailExists: 'An account with this email already exists.',
    signupClosed: 'Sign-up is currently closed.',
  },

  // Welcome
  welcome: {
    title: 'Welcome to Pulse',
    description:
      'Pulse helps you collect structured feedback on your work through guided AI-driven conversations. Invite reviewers, gather insights, and generate a consolidated Pulse Check — all in one place.',
    ctaButton: 'Create your first item',
    documentTitle: 'Welcome — Pulse',
  },

  // Items
  items: {
    title: 'Items',
    documentTitle: 'Items — Pulse',
    emptyState: 'No items yet',
    newItemButton: 'New Item',
    newItemTooltip: 'Create your first item to get started',
    loadError: 'Something went wrong loading your items. Try again.',
    retryButton: 'Retry',
  },

  // Settings
  settings: {
    title: 'Settings',
    documentTitle: 'Settings — Pulse',
    accountSection: 'Account',
    tierLabel: 'Plan',
    tierFree: 'Free',
    usageSection: 'Usage',
    loading: 'Loading…',
    itemsLabel: 'Items',
    sessionsLabel: 'Sessions',
    itemsUsage: '{used} of {max} items',
    sessionsUsage: '{used} of {max} sessions',
    themeSection: 'Appearance',
    themeLabel: 'Theme',
    themeLight: 'Light',
    themeDark: 'Dark',
    themeSystem: 'System',
    signOutButton: 'Sign out',
    deleteAccountButton: 'Delete account',
    deleteAccountTooltip: 'Account deletion is not available in the free tier',
  },

  // Layout
  layout: {
    navItems: 'Items',
    navPulseCheck: 'Pulse Check',
    navSettings: 'Settings',
    logoAlt: 'ur/gd',
    wordmark: 'pulse',
    themeToggleLight: 'Switch to light mode',
    themeToggleDark: 'Switch to dark mode',
    avatarAlt: 'Account',
  },

  // Protected route
  protectedRoute: {
    redirecting: 'Redirecting to login…',
  },
} as const;
