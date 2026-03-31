#!/bin/bash
# security-check.sh — Unified security check for Claude Code hooks and Git hooks
# Exit codes: 0 = allow, 1 = error, 2 = block (Claude Code hook protocol)

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
ERRORS=()

# ============================================================
# Check functions
# ============================================================

check_secrets() {
    local diff_content="$1"
    if [ -z "$diff_content" ]; then return; fi

    local patterns=(
        # API keys with prefixes
        'sk-[a-zA-Z0-9]{20,}'
        'pk-[a-zA-Z0-9]{20,}'
        # AWS
        'AKIA[0-9A-Z]{16}'
        # Generic key assignments
        'api[_-]?(key|secret|token)\s*[=:]\s*['\''"][^'\''"]{8,}'
        'auth[_-]?token\s*[=:]\s*['\''"][^'\''"]{8,}'
        # Passwords
        '(password|passwd|pwd)\s*[=:]\s*['\''"][^'\''"]{8,}'
        # Private keys
        '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'
        # Generic secrets
        'secret[_-]?key\s*[=:]\s*['\''"][^'\''"]{8,}'
        # GitHub/GitLab tokens
        'gh[pousr]_[A-Za-z0-9_]{36,}'
        'glpat-[A-Za-z0-9\-]{20,}'
        # Anthropic
        'sk-ant-[a-zA-Z0-9]{20,}'
    )

    for pattern in "${patterns[@]}"; do
        local matches
        matches=$(echo "$diff_content" | grep -nEi "$pattern" 2>/dev/null | head -5 || true)
        if [ -n "$matches" ]; then
            ERRORS+=("SECRET DETECTED — pattern: $pattern")
            ERRORS+=("$matches")
            ERRORS+=("---")
        fi
    done
}

check_sensitive_files() {
    local staged_files="$1"
    if [ -z "$staged_files" ]; then return; fi

    local sensitive_patterns=(
        '\.env$'
        '\.env\.'
        '\.pem$'
        '\.key$'
        '\.p12$'
        '\.pfx$'
        'credentials\.json'
        'service-account.*\.json'
        'id_rsa'
        'id_ed25519'
        'id_ecdsa'
        '\.sqlite$'
        '\.db$'
        '\.keystore$'
        '\.jks$'
    )

    for pattern in "${sensitive_patterns[@]}"; do
        local matches
        matches=$(echo "$staged_files" | grep -Ei "$pattern" 2>/dev/null || true)
        if [ -n "$matches" ]; then
            while IFS= read -r file; do
                ERRORS+=("SENSITIVE FILE: $file (matches pattern: $pattern)")
            done <<< "$matches"
        fi
    done
}

check_large_files() {
    local staged_files="$1"
    if [ -z "$staged_files" ]; then return; fi

    while IFS= read -r file; do
        [ -z "$file" ] && continue
        [ ! -f "$REPO_ROOT/$file" ] && continue

        local size
        size=$(wc -c < "$REPO_ROOT/$file" 2>/dev/null | tr -d ' ')
        if [ "$size" -gt 10485760 ]; then
            ERRORS+=("LARGE FILE BLOCKED (>10MB): $file (${size} bytes)")
        elif [ "$size" -gt 1048576 ]; then
            echo "WARNING: Large file (>1MB): $file (${size} bytes)" >&2
        fi
    done <<< "$staged_files"
}

check_branch_protection() {
    if [ "$BRANCH" = "archive" ]; then
        ERRORS+=("BRANCH PROTECTED: Cannot commit to 'archive' branch. This branch is a read-only snapshot.")
    fi
}

check_force_push() {
    local command="$1"

    # Block force push (but allow --force-with-lease)
    if echo "$command" | grep -qE 'git\s+push\s+.*--force([^-]|$)' && \
       ! echo "$command" | grep -q 'force-with-lease'; then
        ERRORS+=("FORCE PUSH BLOCKED: Use --force-with-lease instead of --force")
    fi
    if echo "$command" | grep -qE 'git\s+push\s+-[a-zA-Z]*f' && \
       ! echo "$command" | grep -q 'force-with-lease'; then
        ERRORS+=("FORCE PUSH BLOCKED: -f flag detected. Use --force-with-lease instead")
    fi

    # Block deleting remote main/archive
    if echo "$command" | grep -qE 'git\s+push\s+.*:(main|archive)'; then
        ERRORS+=("BRANCH DELETE BLOCKED: Cannot delete remote main or archive branch")
    fi

    # Block git reset --hard
    if echo "$command" | grep -qE 'git\s+reset\s+--hard'; then
        ERRORS+=("RESET BLOCKED: git reset --hard is destructive. Stash or commit your changes first.")
    fi
}

# ============================================================
# Report results
# ============================================================

report() {
    if [ ${#ERRORS[@]} -gt 0 ]; then
        echo "" >&2
        echo "========================================" >&2
        echo "  SECURITY CHECK FAILED" >&2
        echo "========================================" >&2
        for err in "${ERRORS[@]}"; do
            echo "  $err" >&2
        done
        echo "========================================" >&2
        echo "" >&2
        exit 2
    fi
    exit 0
}

# ============================================================
# Entry points
# ============================================================

mode="${1:---claude-auto}"

case "$mode" in
    --pre-commit)
        # Called by git pre-commit hook
        staged_files=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
        staged_diff=$(git diff --cached --diff-filter=ACM 2>/dev/null || true)

        check_branch_protection
        check_secrets "$staged_diff"
        check_sensitive_files "$staged_files"
        check_large_files "$staged_files"
        report
        ;;

    --pre-push)
        # Called by git pre-push hook
        # Read stdin for push info (remote, url, local_ref, local_sha, remote_ref, remote_sha)
        check_branch_protection
        report
        ;;

    --claude-auto)
        # Called by Claude Code PreToolUse hook
        # Read JSON from stdin
        input=$(cat)
        command=$(echo "$input" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

        # Only check git-related commands
        if ! echo "$command" | grep -qE '^git\s+(commit|push|reset)'; then
            exit 0
        fi

        # For git commit: run staged file checks
        if echo "$command" | grep -qE '^git\s+commit'; then
            staged_files=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || true)
            staged_diff=$(git diff --cached --diff-filter=ACM 2>/dev/null || true)

            check_branch_protection
            check_secrets "$staged_diff"
            check_sensitive_files "$staged_files"
            check_large_files "$staged_files"
        fi

        # For git push: run push checks
        if echo "$command" | grep -qE '^git\s+push'; then
            check_branch_protection
            check_force_push "$command"
        fi

        # For git reset --hard
        if echo "$command" | grep -qE '^git\s+reset'; then
            check_force_push "$command"
        fi

        report
        ;;

    *)
        echo "Usage: $0 [--pre-commit|--pre-push|--claude-auto]" >&2
        exit 1
        ;;
esac
