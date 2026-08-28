'use client';

import { useEffect, useRef } from 'react';
import type { Map as LeafletMap, Marker, Circle, DivIcon } from 'leaflet';
// Leaflet's stylesheet is REQUIRED for the map panes, tiles and markers to be
// positioned correctly. Without it the container renders blank/white with
// collapsed (broken-image) markers — this was the root cause of the broken map.
import 'leaflet/dist/leaflet.css';

/**
 * Build a self-contained SVG pin. Using an inline SVG `divIcon` (instead of
 * Leaflet's default <img>-based marker) means the marker can NEVER be a broken
 * image: there is no external asset or bundler-relative path to resolve.
 */
function makePin(L: typeof import('leaflet'), color: string): DivIcon {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 28 40">` +
    `<path d="M14 0C6.27 0 0 6.27 0 14c0 9.6 12.4 23.5 13 24.2.6.7 1.4.7 2 0 .6-.7 13-14.6 13-24.2C28 6.27 21.73 0 14 0z" ` +
    `fill="${color}" stroke="#ffffff" stroke-width="2"/>` +
    `<circle cx="14" cy="14" r="5" fill="#ffffff"/></svg>`;
  return L.divIcon({
    html: svg,
    className: 'omnisight-leaflet-pin',
    iconSize: [28, 40],
    iconAnchor: [14, 38],
    popupAnchor: [0, -36],
  });
}

interface LocationMapProps {
  lat: number;
  lng: number;
  accuracy: number | null;
  /** Popup title (e.g. "Current Location" or a recorded timestamp). */
  title?: string;
  /** Popup subtitle (coordinates / accuracy). */
  subtitle?: string;
  /** Visual emphasis for a selected historical location. */
  highlight?: boolean;
}

/**
 * Client-side Leaflet map showing a geolocation point.
 * Dynamically imported to avoid SSR/window errors.
 * Uses OpenStreetMap tiles (no API key required).
 *
 * When `lat`/`lng` change (e.g. an admin clicks a history row), the marker,
 * accuracy circle and view animate to the new point without leaving the page.
 */
export function LocationMapInner({ lat, lng, accuracy, title, subtitle, highlight }: LocationMapProps) {
  // Default accuracy circle radius when null (IP fallback — no GPS accuracy)
  const effectiveAccuracy = accuracy ?? 10_000;
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const circleRef = useRef<Circle | null>(null);
  const lRef = useRef<typeof import('leaflet') | null>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    // Dynamic import of Leaflet (client-side only)
    import('leaflet').then((L) => {
      if (!mapRef.current) return;
      lRef.current = L;

      const map = L.map(mapRef.current!, {
        center: [lat, lng],
        zoom: 15,
        zoomControl: true,
        scrollWheelZoom: true,
      });

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
      }).addTo(map);

      // Accuracy circle (10km default for IP-based fallback when accuracy is null)
      const circle = L.circle([lat, lng], {
        radius: effectiveAccuracy,
        color: highlight ? '#f59e0b' : '#3b82f6',
        fillColor: highlight ? '#f59e0b' : '#3b82f6',
        fillOpacity: 0.1,
        weight: 1,
      }).addTo(map);

      // Marker — inline SVG pin (no external asset, never a broken image).
      const marker = L.marker([lat, lng], {
        icon: makePin(L, highlight ? '#f59e0b' : '#3b82f6'),
      }).addTo(map);

      const popupHtml = `
        <div style="font-size:12px;line-height:1.4;min-width:160px">
          ${title ? `<div style="font-weight:600;margin-bottom:2px">${title}</div>` : ''}
          ${subtitle ? `<div style="color:#475569">${subtitle}</div>` : ''}
          <div style="color:#64748b;margin-top:2px">${lat.toFixed(5)}, ${lng.toFixed(5)}</div>
        </div>`;
      marker.bindPopup(popupHtml);

      // The container may have been laid out after Leaflet computed its size;
      // recalculate once the browser has painted to avoid a blank/grey map.
      requestAnimationFrame(() => map.invalidateSize());

      mapInstanceRef.current = map;
      markerRef.current = marker;
      circleRef.current = circle;
    }).catch(() => {
      // Leaflet failed to load — map container will show fallback
    });

    return () => {
      mapInstanceRef.current?.remove();
      mapInstanceRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Update marker/circle/icon when coordinates (or selection) change.
  useEffect(() => {
    if (markerRef.current && circleRef.current && mapInstanceRef.current && lRef.current) {
      markerRef.current.setLatLng([lat, lng]);
      markerRef.current.setIcon(makePin(lRef.current, highlight ? '#f59e0b' : '#3b82f6'));
      circleRef.current.setLatLng([lat, lng]);
      circleRef.current.setRadius(effectiveAccuracy);
      const color = highlight ? '#f59e0b' : '#3b82f6';
      circleRef.current.setStyle({ color, fillColor: color });
      mapInstanceRef.current.flyTo([lat, lng], mapInstanceRef.current.getZoom(), { duration: 0.6 });
      requestAnimationFrame(() => mapInstanceRef.current?.invalidateSize());
    }
  }, [lat, lng, accuracy, highlight]);

  return (
    <div
      ref={mapRef}
      className="h-[300px] w-full rounded-lg"
      style={{ zIndex: 0 }}
    />
  );
}
