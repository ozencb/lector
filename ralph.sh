#!/bin/bash
# Ralph Wiggum - Autonomous AI agent loop for TTS Reader
# Usage: ./ralph.sh [max_iterations]

set -e

MAX_ITERATIONS=${1:-20}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRD_FILE="$SCRIPT_DIR/docs/ai/prd.json"
PROGRESS_FILE="$SCRIPT_DIR/docs/ai/progress.txt"

# Initialize progress file if it doesn't exist
if [ ! -f "$PROGRESS_FILE" ]; then
  echo "# Ralph Progress Log" > "$PROGRESS_FILE"
  echo "Started: $(date)" >> "$PROGRESS_FILE"
  echo "---" >> "$PROGRESS_FILE"
fi

# Ensure we're on the right branch
BRANCH=$(jq -r '.branchName' "$PRD_FILE")
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "")

if [ "$CURRENT_BRANCH" != "$BRANCH" ]; then
  if git show-ref --verify --quiet "refs/heads/$BRANCH" 2>/dev/null; then
    git checkout "$BRANCH"
  else
    git checkout -b "$BRANCH"
  fi
fi

echo "Starting Ralph - Max iterations: $MAX_ITERATIONS"
echo "Branch: $BRANCH"

for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "==============================================================="
  echo "  Ralph Iteration $i of $MAX_ITERATIONS"
  echo "==============================================================="

  # Check if all stories pass
  REMAINING=$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE")
  if [ "$REMAINING" -eq 0 ]; then
    echo ""
    echo "All stories complete! Nothing left to do."
    exit 0
  fi

  echo "Remaining stories: $REMAINING"

  OUTPUT=$(claude --dangerously-skip-permissions --print < "$SCRIPT_DIR/CLAUDE.md" 2>&1 | tee /dev/stderr) || true

  # Check for completion signal
  if echo "$OUTPUT" | grep -q "<promise>COMPLETE</promise>"; then
    echo ""
    echo "Ralph completed all tasks!"
    echo "Completed at iteration $i of $MAX_ITERATIONS"
    exit 0
  fi

  echo "Iteration $i complete. Continuing..."
  sleep 2
done

echo ""
echo "Ralph reached max iterations ($MAX_ITERATIONS) without completing all tasks."
echo "Check $PROGRESS_FILE for status."
exit 1
