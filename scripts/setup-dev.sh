#!/usr/bin/env bash
set -euo pipefail

# Dev environment setup for pulse
# Installs the pre-commit security scanning hook and verifies tooling.

echo "🔧 Setting up pulse development environment..."

# Install pre-commit hook
echo "Installing pre-commit hook..."
cp scripts/hooks/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
echo "✅ Pre-commit hook installed"

# Verify security tools
echo "Checking security tools..."
MISSING=()
command -v cfn-lint &>/dev/null || MISSING+=("cfn-lint")
command -v checkov &>/dev/null || MISSING+=("checkov")
command -v semgrep &>/dev/null || MISSING+=("semgrep")

if [ ${#MISSING[@]} -gt 0 ]; then
  echo "⚠️  Missing tools: ${MISSING[*]}"
  echo "Install with: pip install --upgrade cfn-lint checkov semgrep"
  exit 1
fi

echo "✅ All security tools installed"
echo ""
echo "========================================"
echo "✅ Development environment ready"
echo "========================================"
echo ""
echo "Pre-commit hook runs on every commit:"
echo "  - cfn-lint  (CloudFormation validation)"
echo "  - Checkov   (infrastructure security)"
echo "  - Semgrep   (code security)"
