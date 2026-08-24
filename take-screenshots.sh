#!/bin/bash
B="$HOME/.claude/skills/gstack/browse/dist/browse"
DIR="screenshots"

# Function to navigate and screenshot
page_screenshot() {
  local ref=$1
  local name=$2
  local wait=${3:-2}
  echo "Capturing: $name"
  $B click "$ref"
  sleep "$wait"
  $B screenshot "$DIR/$name" 2>&1 | tail -1
}

# Dashboard is already loaded
echo "Dashboard already captured."

# Navigate to each page
echo "=== OVERVIEW ==="
page_screenshot "@e3" "03-employees.png" 3
page_screenshot "@e4" "04-departments.png" 2
page_screenshot "@e5" "05-devices.png" 3
page_screenshot "@e6" "06-activities.png" 3
page_screenshot "@e7" "07-screenshots.png" 3
page_screenshot "@e8" "08-break-monitor.png" 3
page_screenshot "@e9" "09-live-monitor.png" 3
page_screenshot "@e10" "10-analytics.png" 3

echo "=== INTELLIGENCE ==="
page_screenshot "@e11" "11-ai-insights.png" 3
page_screenshot "@e12" "12-sentiment.png" 3
page_screenshot "@e13" "13-ai-provider.png" 3

echo "=== SECURITY ==="
page_screenshot "@e14" "14-agent-approvals.png" 3
page_screenshot "@e15" "15-guests.png" 3
page_screenshot "@e16" "16-notifications.png" 3
page_screenshot "@e17" "17-alerts.png" 3
page_screenshot "@e18" "18-audit-logs.png" 3

echo "All navigation pages captured!"
