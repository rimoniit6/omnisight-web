export interface TourStep {
  target: string;
  title: string;
  content: string;
  placement: 'bottom' | 'top' | 'left' | 'right';
}

export const tourSteps: TourStep[] = [
  {
    target: 'sidebar',
    title: 'Welcome to OmniSight! 👋',
    content:
      'This is your navigation sidebar. Use it to switch between all pages — from Dashboard and Employees to AI Insights and Reports. Click the arrow at the bottom to collapse it for more space.',
    placement: 'right',
  },
  {
    target: 'dashboard-content',
    title: 'Your Dashboard',
    content:
      'Here you\'ll find KPI cards showing total employees, online devices, average productivity, and active alerts. The charts below give you a quick overview of team performance and department distribution.',
    placement: 'bottom',
  },
  {
    target: 'search',
    title: 'Quick Search & Command Palette ⌘K',
    content:
      'Press ⌘K (or Ctrl+K) to open the command palette. You can search for pages, employees, devices, and actions instantly without navigating through the sidebar.',
    placement: 'bottom',
  },
  {
    target: 'notifications',
    title: 'Notifications & Alerts',
    content:
      'The bell icon shows your unread notification count. Click it to see the latest updates — policy alerts, system events, and AI-generated insights. The sidebar also shows a red badge when you have unread items.',
    placement: 'bottom',
  },
  {
    target: 'theme-toggle',
    title: 'Dark & Light Mode',
    content:
      'Toggle between dark and light themes to match your preference. Your choice is automatically saved for the next visit.',
    placement: 'bottom',
  },
  {
    target: 'dashboard-content',
    title: 'You\'re All Set! 🎉',
    content:
      'You\'ve completed the tour! Explore the AI Insights page to see intelligent recommendations, or check the Analytics page for detailed productivity trends. Happy monitoring!',
    placement: 'bottom',
  },
];
