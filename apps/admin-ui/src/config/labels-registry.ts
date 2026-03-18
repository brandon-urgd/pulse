// All user-facing strings — no hardcoded text in components

export const labels = {
  // Splash entry
  splash: {
    pulseCodeLabel: 'Pulse code',
    pulseCodePlaceholder: 'Enter your pulse code',
    pulseCodeError: "That code doesn\u2019t look right. Check your invitation email.",
    joinButton: 'Join session',
    loginButton: 'Log in',
    signUpButton: 'Sign up',
    backButton: 'Back',
  },

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
    registrationSuccess: 'Account created. Check your email for a temporary password, then sign in below.',
  },

  // Auth — Register
  register: {
    title: 'Create your account',
    nameLabel: 'Name',
    emailLabel: 'Email',
    passwordLabel: 'Password',
    submitButton: 'Create account',
    verificationTitle: 'Check your email',
    verificationDescription: 'We sent a temporary password to {email}.',
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
    loadError: 'Something went wrong loading your items. Try again.',
    retryButton: 'Retry',
    statusDraft: 'Draft',
    statusActive: 'Active',
    statusClosed: 'Closed',
    statusRevised: 'Revised',
    sessionCount: '{count} sessions',
    closeDate: 'Closes',
  },

  // Item detail
  itemDetail: {
    newDocumentTitle: 'New Item — Pulse',
    editDocumentTitle: '{itemName} — Pulse',
    newHeading: 'New Item',
    editHeading: 'Edit Item',
    fieldName: 'Item name',
    fieldNamePlaceholder: 'Enter item name',
    fieldDescription: 'Description',
    fieldDescriptionPlaceholder: 'Brief description of this item',
    fieldCloseDate: 'Close date',
    fieldContent: 'Content',
    fieldContentPlaceholder: 'Paste your content here (Markdown supported)',
    contentModeTextarea: 'Paste content',
    contentModeUpload: 'Upload file',
    uploadAcceptHint: 'Accepts .md, .txt, .pdf, .docx — max 10 MB',
    uploadChooseFile: 'Choose file',
    uploadStatusScanning: 'Scanning file for security threats…',
    uploadStatusExtracting: 'Extracting text from document…',
    uploadStatusReady: 'Document ready',
    uploadStatusRejected: 'File was rejected — security threat detected',
    uploadStatusExtractionFailed: 'Could not extract text from this file',
    uploadOnlyEditMode: 'Save the item first to enable file upload.',
    saveButton: 'Save',
    cancelButton: 'Cancel',
    deleteButton: 'Delete item',
    lockedError: 'This item is locked and cannot be edited',
    saveError: 'Failed to save item. Please try again.',
    loadError: 'Failed to load item.',
    deleteConfirmTitle: 'Delete item',
    deleteConfirmMessage:
      'Are you sure you want to delete {itemName}? This will also delete all sessions, transcripts, and reports associated with this item.',
    deleteConfirmCancel: 'Cancel',
    deleteConfirmDelete: 'Delete',
    deleteError: 'Failed to delete item. Please try again.',
    readOnlyNotice: 'This item is locked and cannot be edited.',
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
