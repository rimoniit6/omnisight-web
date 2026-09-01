'use client';

import { LocationPanel } from '@/components/employees/telemetry/location-panel';

// TEMPORARY diagnostic route — renders the real LocationPanel for the
// employee that actually has location data, to reproduce the map rendering
// path in the live app. Remove after diagnosis.
export default function DebugMapPage() {
  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>Debug Map</h1>
      <LocationPanel employeeId="cmtckt5u7006ffi68jpl5kr5s" />
    </div>
  );
}
