// Deep-link tab routing for Employee Details.
//
// The portal (Employee Portal → Telemetry) and other summary surfaces want to
// open Employee Details on a SPECIFIC tab (keyboard / location / webcam /
// websites). Employee Details owns its tab state, so we pass the desired tab
// through a tiny module-level slot that the details page consumes once on
// mount — no events, no polling, no store coupling.

let pendingTab: string | null = null;

/** Request a specific Employee Details tab for the NEXT mount. */
export function setPendingEmployeeTab(tab: string | null): void {
  pendingTab = tab;
}

/** Read and clear the pending tab (called once when Employee Details mounts). */
export function consumePendingEmployeeTab(): string | null {
  const tab = pendingTab;
  pendingTab = null;
  return tab;
}
