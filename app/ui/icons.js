// Sidebar glyphs: 18 px, colored by the category (currentColor). Simple filled shapes, Things-like.
const svg = (inner, extra = '') => `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;
export const ICONS = {
  logo: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="10" cy="10" r="5.5"/><circle cx="10" cy="10" r="1.6" fill="#fff" stroke="none"/></svg>`,
  overview: svg('<path d="M10 2.6l2.3 4.7 5.2.8-3.8 3.6.9 5.1L10 14.4l-4.6 2.4.9-5.1L2.5 8.1l5.2-.8z" fill="currentColor" stroke="none"/>'),
  calendar: svg('<rect x="3" y="4" width="14" height="13" rx="2.5" fill="currentColor" stroke="none"/><rect x="3" y="4" width="14" height="4" rx="2.5" fill="currentColor" stroke="none" opacity=".55"/><path d="M6.5 2.5v3M13.5 2.5v3" stroke="currentColor"/><rect x="5.5" y="10" width="3" height="3" rx=".6" fill="#fff" stroke="none" opacity=".9"/>'),
  experiments: svg('<path d="M7.5 2.5h5M8.5 2.5v5.2L4.3 15a1.8 1.8 0 0 0 1.6 2.6h8.2a1.8 1.8 0 0 0 1.6-2.6L11.5 7.7V2.5" fill="currentColor" fill-opacity=".18"/><path d="M6.2 12h7.6" />'),
  batches: svg('<rect x="4" y="2.5" width="12" height="15" rx="2" fill="currentColor" fill-opacity=".18"/><path d="M7 7h6M7 10h6M7 13h4"/>'),
  stocks: svg('<path d="M10 2.5c3 3.9 5 6.6 5 9.1a5 5 0 0 1-10 0c0-2.5 2-5.2 5-9.1z" fill="currentColor" stroke="none"/>'),
  buffers: svg('<path d="M6 2.5h8M7.5 2.5v4.3L3.6 14.5A2 2 0 0 0 5.4 17.5h9.2a2 2 0 0 0 1.8-3L12.5 6.8V2.5"/><path d="M5.2 12.5h9.6v3a2 2 0 0 1-2 2H7.2a2 2 0 0 1-2-2z" fill="currentColor" stroke="none"/>'),
  measurements: svg('<path d="M3 16.5V4M3 16.5h14"/><path d="M5.5 13l3.5-4 3 2.5 4-5.5" stroke-width="2"/>'),
  doe: svg('<circle cx="5" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="5" r="2" fill="currentColor" stroke="none"/><circle cx="5" cy="15" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="2" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="2.4" fill="currentColor" stroke="none" opacity=".55"/>'),
  learn: svg('<path d="M3.2 4.6h5.3c.9 0 1.6.7 1.6 1.6v9.3c0-.7-.6-1.3-1.3-1.3H3.2V4.6Z" fill="currentColor" fill-opacity=".18"/><path d="M16.8 4.6h-5.3c-.9 0-1.6.7-1.6 1.6v9.3c0-.7.6-1.3 1.3-1.3h5.6V4.6Z"/><path d="M10 6.2v9.3"/>'),
  designs: svg('<rect x="2.8" y="3.2" width="6" height="6" rx="1.4" fill="currentColor" fill-opacity=".18"/><rect x="11.2" y="3.2" width="6" height="6" rx="1.4"/><rect x="2.8" y="10.8" width="6" height="6" rx="1.4"/><rect x="11.2" y="10.8" width="6" height="6" rx="1.4" fill="currentColor" fill-opacity=".18"/>'),
  advisor: svg('<circle cx="10" cy="10" r="7"/><path d="M8.1 7.9a1.95 1.95 0 1 1 2.6 1.85c-.5.18-.7.5-.7 1v.55" stroke-linecap="round"/><circle cx="10" cy="14.2" r=".95" fill="currentColor" stroke="none"/>'),
  ml: svg('<circle cx="4.5" cy="6" r="1.9" fill="currentColor" stroke="none"/><circle cx="4.5" cy="14" r="1.9" fill="currentColor" stroke="none"/><circle cx="11" cy="10" r="1.9" fill="currentColor" stroke="none" opacity=".75"/><circle cx="16.5" cy="6.5" r="1.9" fill="currentColor" stroke="none" opacity=".5"/><circle cx="16.5" cy="13.5" r="1.9" fill="currentColor" stroke="none" opacity=".5"/><path d="M6.1 6.8 9.4 9.2M6.1 13.2 9.4 10.8M12.6 9.2l2.4-1.8M12.6 10.8l2.4 1.8"/>'),
  data: svg('<rect x="3" y="3.5" width="14" height="13" rx="1.5"/><path d="M3 7.5h14M3 11.5h14M8 7.5v9"/>'),
  insights: svg('<rect x="3" y="10" width="3.2" height="7" rx="1" fill="currentColor" stroke="none"/><rect x="8.4" y="6" width="3.2" height="11" rx="1" fill="currentColor" stroke="none"/><rect x="13.8" y="3" width="3.2" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  materials: svg('<path d="M10 2.8l7 3.5v7.4l-7 3.5-7-3.5V6.3z" fill="currentColor" fill-opacity=".18"/><path d="M3 6.3l7 3.5 7-3.5M10 9.8v7.4"/>'),
  quarantine: svg('<rect x="3" y="4" width="14" height="12.5" rx="2" fill="currentColor" fill-opacity=".18"/><path d="M3 8.5h14M10 11v3M10 15.6v.1" stroke-width="1.8"/>'),
  studies: svg('<circle cx="7" cy="7" r="3.2" fill="currentColor" fill-opacity=".18"/><circle cx="13.5" cy="12.5" r="3.6"/><path d="M9.3 9.3l1.7 1.6M4 15.5h3M5.5 14v3"/>'),
  settings: svg('<circle cx="10" cy="10" r="2.6"/><path d="M10 2.8v2.2M10 15v2.2M2.8 10H5M15 10h2.2M4.9 4.9l1.6 1.6M13.5 13.5l1.6 1.6M4.9 15.1l1.6-1.6M13.5 6.5l1.6-1.6"/>'),
};
