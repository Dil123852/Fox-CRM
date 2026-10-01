// Sidebar nav icons, transcribed VERBATIM from the reference design's own SVG
// paths rather than approximated with lucide equivalents — the reference uses
// custom glyphs (the bar-chart "Pipeline" mark, the arrow-out "Callbacks"
// phone, the gear-person "User Management") that lucide has no exact match for,
// and swapping in near-misses is what makes a rebuilt sidebar look subtly wrong.
//
// Every icon shares the reference's geometry: 24x24 viewBox, no fill, 1.8
// stroke, round caps and joins. `size` and `strokeWidth` are props only so the
// active-state weight can still be bumped the way the old lucide icons did.

function Svg({ size = 14, strokeWidth = 1.8, children, ...rest }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const PipelineIcon = p => (
  <Svg {...p}>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="9.5" y="4" width="5" height="11" rx="1.5" />
    <rect x="16" y="4" width="5" height="7" rx="1.5" />
  </Svg>
);

export const OrdersIcon = p => (
  <Svg {...p}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <polyline points="3.3 7 12 12 20.7 7" />
    <line x1="12" y1="22" x2="12" y2="12" />
  </Svg>
);

export const ChatsIcon = p => (
  <Svg {...p}>
    <path d="M21 11.5a8.38 8.38 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l2-5.2A8.4 8.4 0 0 1 4 11.5a8.38 8.38 0 0 1 8.5-8.4 8.38 8.38 0 0 1 8.5 8.4z" />
  </Svg>
);

export const CallsIcon = p => (
  <Svg {...p}>
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
  </Svg>
);

// The reference's callbacks glyph: the calls handset with an outbound arrow.
export const CallbacksIcon = p => (
  <Svg {...p}>
    <polyline points="16 2.5 16 8 21.5 8" />
    <line x1="22.5" y1="1.5" x2="16" y2="8" />
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />
  </Svg>
);

export const CustomersIcon = p => (
  <Svg {...p}>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Svg>
);

export const InsightsIcon = p => (
  <Svg {...p}>
    <line x1="4" y1="20" x2="20" y2="20" />
    <rect x="5.5" y="11" width="3.5" height="6" rx="1" />
    <rect x="10.5" y="7" width="3.5" height="10" rx="1" />
    <rect x="15.5" y="3.5" width="3.5" height="13.5" rx="1" />
  </Svg>
);

export const TeamIcon = p => (
  <Svg {...p}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Svg>
);

export const InventoryIcon = p => (
  <Svg {...p}>
    <rect x="2.5" y="4" width="19" height="4.5" rx="1.3" />
    <path d="M4.3 8.5V19a1.5 1.5 0 0 0 1.5 1.5h12.4a1.5 1.5 0 0 0 1.5-1.5V8.5" />
    <line x1="9.8" y1="13" x2="14.2" y2="13" />
  </Svg>
);

export const WarrantyIcon = p => (
  <Svg {...p}>
    <path d="M12 22s8-3.6 8-10V5.2l-8-3-8 3V12c0 6.4 8 10 8 10z" />
    <polyline points="8.8 11.8 11.2 14.2 15.4 9.8" />
  </Svg>
);

export const PromoIcon = p => (
  <Svg {...p}>
    <path d="M20.6 13.1 13 20.7a1.8 1.8 0 0 1-2.6 0l-7.1-7.1a1.8 1.8 0 0 1-.5-1.3V4.6A1.6 1.6 0 0 1 4.4 3h7.7c.5 0 1 .2 1.3.5l7.2 7.2a1.7 1.7 0 0 1 0 2.4z" />
    <line x1="7.4" y1="7.4" x2="7.41" y2="7.4" />
  </Svg>
);

export const BulkIcon = p => (
  <Svg {...p}>
    <path d="M3 11v2.5a1.5 1.5 0 0 0 1.5 1.5H7l7 4.5V6.5L7 11z" />
    <path d="M7 11v4" />
    <path d="M17.5 9.2a4 4 0 0 1 0 5.6" />
    <path d="M20 6.8a7.5 7.5 0 0 1 0 10.4" />
  </Svg>
);

export const UserMgmtIcon = p => (
  <Svg {...p}>
    <path d="M13 21v-1.6a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V21" />
    <circle cx="7.5" cy="7.5" r="3.8" />
    <circle cx="18" cy="15.5" r="2.4" />
    <path d="M18 11.8v1.3M18 17.9v1.3M21.2 13.6l-1.1.7M15.9 16.7l-1.1.7M21.2 17.4l-1.1-.7M15.9 14.3l-1.1-.7" />
  </Svg>
);

// Oversight (super_admin only): a shield with a tick — the audit trail, the
// deleted-record bin and staff hours all live behind it.
export const OversightIcon = p => (
  <Svg {...p}>
    <path d="M12 2.8 20 6v6.2c0 4.5-3.2 7.9-8 9.2-4.8-1.3-8-4.7-8-9.2V6l8-3.2Z" />
    <path d="M9 12.2l2.2 2.2L15.4 10" />
  </Svg>
);

// The reference's ⋮ overflow control on the user card. Filled, not stroked.
export const DotsIcon = ({ size = 13, ...rest }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"
    aria-hidden="true" focusable="false" {...rest}>
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </svg>
);
